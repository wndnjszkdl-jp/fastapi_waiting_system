from __future__ import annotations

import json
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "waiting.db"
ROOMS = ("A", "B", "C")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                room TEXT PRIMARY KEY,
                current_number INTEGER NOT NULL DEFAULT 0,
                issued_number INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS system_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                event_id INTEGER NOT NULL DEFAULT 0,
                last_room TEXT,
                last_number INTEGER,
                last_action TEXT
            )
            """
        )
        for room in ROOMS:
            connection.execute(
                """
                INSERT OR IGNORE INTO rooms(room, current_number, issued_number)
                VALUES (?, 0, 0)
                """,
                (room,),
            )
        connection.execute(
            """
            INSERT OR IGNORE INTO system_state(id, event_id, last_action)
            VALUES (1, 0, 'ready')
            """
        )
        connection.commit()


def read_state() -> dict:
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT room, current_number, issued_number FROM rooms ORDER BY room"
        ).fetchall()
        system = connection.execute(
            "SELECT event_id, last_room, last_number, last_action FROM system_state WHERE id = 1"
        ).fetchone()

    rooms = {}
    for row in rows:
        current = int(row["current_number"])
        issued = int(row["issued_number"])
        rooms[row["room"]] = {
            "current": current,
            "issued": issued,
            "waiting": max(0, issued - current),
        }

    return {
        "rooms": rooms,
        "event_id": int(system["event_id"]),
        "last_call": {
            "room": system["last_room"],
            "number": system["last_number"],
            "action": system["last_action"],
        },
    }


def set_last_event(connection: sqlite3.Connection, action: str, room: str | None, number: int | None) -> None:
    connection.execute(
        """
        UPDATE system_state
        SET event_id = event_id + 1,
            last_room = ?,
            last_number = ?,
            last_action = ?
        WHERE id = 1
        """,
        (room, number, action),
    )


class RoomAction(BaseModel):
    room: Literal["A", "B", "C"]


class SetRoomNumbers(BaseModel):
    room: Literal["A", "B", "C"]
    current: int = Field(ge=0, le=9999)
    issued: int = Field(ge=0, le=9999)


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict) -> None:
        disconnected: list[WebSocket] = []
        payload = json.dumps(message, ensure_ascii=False)
        for connection in self.active_connections:
            try:
                await connection.send_text(payload)
            except Exception:
                disconnected.append(connection)
        for connection in disconnected:
            self.disconnect(connection)


manager = ConnectionManager()


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="스마트 대기 안내 시스템",
    description="관리자 호출 화면과 은행식 대기 화면을 실시간으로 연결합니다.",
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    return RedirectResponse(url="/display")


@app.get("/display", response_class=HTMLResponse, include_in_schema=False)
async def display_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="display.html",
        context={"rooms": ROOMS},
    )


@app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
async def admin_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="admin.html",
        context={"rooms": ROOMS},
    )


@app.get("/api/state")
async def get_state():
    return read_state()


@app.post("/api/ticket")
async def issue_ticket(payload: RoomAction):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT issued_number FROM rooms WHERE room = ?", (payload.room,)
        ).fetchone()
        next_number = int(row["issued_number"]) + 1
        connection.execute(
            "UPDATE rooms SET issued_number = ? WHERE room = ?",
            (next_number, payload.room),
        )
        set_last_event(connection, "ticket", payload.room, next_number)
        connection.commit()

    state = read_state()
    await manager.broadcast({"type": "state", "state": state})
    return {"ok": True, "ticket": {"room": payload.room, "number": next_number}, "state": state}


@app.post("/api/call-next")
async def call_next(payload: RoomAction):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT current_number, issued_number FROM rooms WHERE room = ?",
            (payload.room,),
        ).fetchone()
        current = int(row["current_number"])
        issued = int(row["issued_number"])

        if current >= issued:
            raise HTTPException(
                status_code=409,
                detail=f"{payload.room}방에 대기 중인 번호가 없습니다.",
            )

        next_number = current + 1
        connection.execute(
            "UPDATE rooms SET current_number = ? WHERE room = ?",
            (next_number, payload.room),
        )
        set_last_event(connection, "call", payload.room, next_number)
        connection.commit()

    state = read_state()
    await manager.broadcast(
        {
            "type": "call",
            "room": payload.room,
            "number": next_number,
            "state": state,
        }
    )
    return {"ok": True, "call": {"room": payload.room, "number": next_number}, "state": state}


@app.post("/api/recall")
async def recall(payload: RoomAction):
    state = read_state()
    current = state["rooms"][payload.room]["current"]
    if current <= 0:
        raise HTTPException(
            status_code=409,
            detail=f"{payload.room}방에서 아직 호출한 번호가 없습니다.",
        )

    with get_connection() as connection:
        set_last_event(connection, "recall", payload.room, current)
        connection.commit()

    state = read_state()
    await manager.broadcast(
        {
            "type": "call",
            "room": payload.room,
            "number": current,
            "state": state,
        }
    )
    return {"ok": True, "call": {"room": payload.room, "number": current}, "state": state}


@app.post("/api/undo")
async def undo(payload: RoomAction):
    with get_connection() as connection:
        row = connection.execute(
            "SELECT current_number FROM rooms WHERE room = ?", (payload.room,)
        ).fetchone()
        current = int(row["current_number"])
        new_current = max(0, current - 1)
        connection.execute(
            "UPDATE rooms SET current_number = ? WHERE room = ?",
            (new_current, payload.room),
        )
        set_last_event(connection, "undo", payload.room, new_current)
        connection.commit()

    state = read_state()
    await manager.broadcast({"type": "state", "state": state})
    return {"ok": True, "state": state}


@app.post("/api/set-room")
async def set_room_numbers(payload: SetRoomNumbers):
    if payload.current > payload.issued:
        raise HTTPException(
            status_code=422,
            detail="현재 호출 번호는 발급 번호보다 클 수 없습니다.",
        )

    with get_connection() as connection:
        connection.execute(
            """
            UPDATE rooms
            SET current_number = ?, issued_number = ?
            WHERE room = ?
            """,
            (payload.current, payload.issued, payload.room),
        )
        set_last_event(connection, "manual", payload.room, payload.current)
        connection.commit()

    state = read_state()
    await manager.broadcast({"type": "state", "state": state})
    return {"ok": True, "state": state}


@app.post("/api/reset")
async def reset_all():
    with get_connection() as connection:
        connection.execute("UPDATE rooms SET current_number = 0, issued_number = 0")
        set_last_event(connection, "reset", None, None)
        connection.commit()

    state = read_state()
    await manager.broadcast({"type": "reset", "state": state})
    return {"ok": True, "state": state}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json({"type": "state", "state": read_state()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)
