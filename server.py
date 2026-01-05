import json
import os
import uuid
import time
import asyncio
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, WebSocket, HTTPException, Depends, Response, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
CHATS_FILE = os.path.join(DATA_DIR, "chats.json")
STORIES_FILE = os.path.join(DATA_DIR, "stories.json")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(PUBLIC_DIR, exist_ok=True)

# --- MODELOS ---
class UserLogin(BaseModel):
    username: str
    password: str

class UserRegister(BaseModel):
    username: str
    name: str
    password: str

class UserProfileUpdate(BaseModel):
    username: str
    name: str
    bio: str
    avatarSeed: str
    theme: str
    darkMode: bool

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class CreateChatRequest(BaseModel):
    target_user_id: str

class StoryCreate(BaseModel):
    image: str
    caption: Optional[str] = ""

# --- UTILIDADES JSON ---
def load_json(filepath: str, default):
    if not os.path.exists(filepath):
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2, ensure_ascii=False)
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def save_json(filepath: str, data):
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
    except Exception as e:
        print(f"Error guardando JSON: {e}")

def now_ms() -> int:
    return int(time.time() * 1000)

# --- STORIES HELPERS ---
STORY_TTL_MS = 24 * 60 * 60 * 1000  # 24h

def load_stories_clean() -> List[dict]:
    stories = load_json(STORIES_FILE, [])
    t = now_ms()
    cleaned = []
    for s in stories:
        try:
            exp = int(s.get("expiresAt") or 0)
            if exp <= t:
                continue
            cleaned.append(s)
        except Exception:
            continue
    if len(cleaned) != len(stories):
        save_json(STORIES_FILE, cleaned)
    return cleaned

def story_user_public(u: dict) -> dict:
    return {
        "id": u.get("id"),
        "username": u.get("username", ""),
        "name": u.get("name", ""),
        "avatarSeed": u.get("avatarSeed", ""),
        "is_admin": bool(u.get("is_admin", False)),
    }

# --- WEBSOCKET MANAGER ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        async with self._lock:
            self.active_connections.setdefault(user_id, [])
            self.active_connections[user_id].append(websocket)

    async def disconnect(self, websocket: WebSocket, user_id: str) -> bool:
        """True si sigue online (otra conexión activa), False si se desconectó totalmente."""
        async with self._lock:
            if user_id in self.active_connections:
                if websocket in self.active_connections[user_id]:
                    self.active_connections[user_id].remove(websocket)
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
                    return False
                return True
            return False

    async def close_all_for_user(self, user_id: str):
        conns = []
        async with self._lock:
            conns = self.active_connections.get(user_id, [])[:]

        for w in conns:
            try:
                await w.close()
            except Exception:
                pass

        async with self._lock:
            if user_id in self.active_connections:
                del self.active_connections[user_id]

    async def send_personal_message(self, message: dict, user_id: str):
        async with self._lock:
            conns = self.active_connections.get(user_id, [])[:]

        if not conns:
            return

        for connection in conns:
            try:
                await connection.send_json(message)
            except Exception:
                try:
                    await self.disconnect(connection, user_id)
                except Exception:
                    pass

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active_connections

    async def broadcast(self, message: dict):
        async with self._lock:
            user_ids = list(self.active_connections.keys())
        for user_id in user_ids:
            await self.send_personal_message(message, user_id)

    async def send_presence_snapshot(self, websocket: WebSocket):
        try:
            async with self._lock:
                online = list(self.active_connections.keys())
            await websocket.send_json({"type": "presence_snapshot", "onlineUserIds": online})
        except Exception:
            pass

manager = ConnectionManager()

# --- AUTH HELPERS ---
def get_user_by_id(user_id: str):
    users = load_json(USERS_FILE, [])
    for u in users:
        if u.get("id") == user_id:
            return u
    return None

sessions: Dict[str, str] = {}

async def get_current_user(request: Request):
    token = request.cookies.get("session_token")
    if not token:
        auth = request.headers.get("Authorization")
        if auth and " " in auth:
            token = auth.split(" ", 1)[1]

    if not token or token not in sessions:
        raise HTTPException(status_code=401, detail="No autenticado")

    user_id = sessions[token]
    user = get_user_by_id(user_id)

    if not user:
        del sessions[token]
        raise HTTPException(status_code=401, detail="Usuario inválido")

    if user.get("is_banned", False):
        raise HTTPException(status_code=403, detail="Cuenta suspendida")

    return user

# --- ENDPOINTS ---

@app.post("/auth/register")
async def register(creds: UserRegister, response: Response):
    users = load_json(USERS_FILE, [])

    if any(u.get("username", "").lower() == creds.username.lower() for u in users):
        raise HTTPException(status_code=400, detail="El nombre de usuario ya existe")

    new_id = str(uuid.uuid4())
    default_seed = str(uuid.uuid4())[:8]

    new_user = {
        "id": new_id,
        "username": creds.username,
        "name": creds.name,
        "password": creds.password,
        "bio": "¡Hola! Estoy usando wow.",
        "avatarSeed": default_seed,
        "theme": "default",
        "darkMode": False,
        "joined_at": time.strftime("%d/%m/%Y"),
        "is_admin": False,
        "is_banned": False
    }

    users.append(new_user)
    save_json(USERS_FILE, users)

    token = str(uuid.uuid4())
    sessions[token] = new_id
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
    )

    return {"message": "Registrado correctamente", "user": {k:v for k,v in new_user.items() if k != "password"}, "token": token}


@app.post("/auth/login")
async def login(creds: UserLogin, response: Response):
    users = load_json(USERS_FILE, [])
    user = next((u for u in users if (u.get("username","").lower() == creds.username.lower())), None)

    if not user or user.get("password") != creds.password:
        raise HTTPException(status_code=401, detail="Credenciales incorrectas")

    if user.get("is_banned", False):
        raise HTTPException(status_code=403, detail="Cuenta suspendida")

    token = str(uuid.uuid4())
    sessions[token] = user["id"]
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
    )
    return {"message": "OK", "user": {k:v for k,v in user.items() if k != "password"}, "token": token}


@app.post("/auth/logout")
async def logout(response: Response, request: Request):
    token = request.cookies.get("session_token")
    user_id = sessions.get(token) if token else None

    if token in sessions:
        del sessions[token]

    response.delete_cookie("session_token")

    if user_id:
        await manager.close_all_for_user(user_id)
        await manager.broadcast({"type": "user_status", "userId": user_id, "status": "offline"})

    return {"message": "OK"}


@app.post("/auth/change-password")
async def change_pass(req: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    users = load_json(USERS_FILE, [])
    for i, u in enumerate(users):
        if u["id"] == user["id"]:
            if u.get("password") != req.current_password:
                raise HTTPException(status_code=400, detail="Password actual incorrecto")
            users[i]["password"] = req.new_password
            save_json(USERS_FILE, users)
            return {"message": "Password actualizado"}
    raise HTTPException(404, detail="Error interno")


@app.get("/api/me")
async def me(user: dict = Depends(get_current_user)):
    return {k:v for k,v in user.items() if k != "password"}


@app.post("/api/me/profile")
async def update_profile(p: UserProfileUpdate, user: dict = Depends(get_current_user)):
    users = load_json(USERS_FILE, [])

    for u in users:
        if u.get("username","").lower() == p.username.lower() and u["id"] != user["id"]:
            raise HTTPException(status_code=400, detail="Nombre de usuario en uso")

    for i, u in enumerate(users):
        if u["id"] == user["id"]:
            users[i].update(p.dict())
            save_json(USERS_FILE, users)
            return {k:v for k,v in users[i].items() if k != "password"}

    raise HTTPException(404, detail="No encontrado")


@app.get("/api/users")
async def list_users(user: dict = Depends(get_current_user)):
    users = load_json(USERS_FILE, [])
    return [
        {k:v for k,v in u.items() if k != "password"}
        for u in users
        if u["id"] != user["id"] and not u.get("is_banned", False)
    ]


@app.get("/api/users/{uid}")
async def get_profile(uid: str, user: dict = Depends(get_current_user)):
    u = get_user_by_id(uid)
    if not u:
        raise HTTPException(404, detail="No encontrado")
    if u.get("is_banned", False) and not user.get("is_admin", False):
        raise HTTPException(404, detail="No encontrado")
    return {k:v for k,v in u.items() if k != "password"}

# --- STORIES ENDPOINTS ---

@app.get("/api/stories")
async def get_stories(user: dict = Depends(get_current_user)):
    stories = load_stories_clean()
    out = []
    for s in stories:
        u = get_user_by_id(s.get("userId"))
        if not u:
            continue
        if u.get("is_banned", False) and not user.get("is_admin", False):
            continue
        out.append({
            "id": s.get("id"),
            "image": s.get("image"),
            "caption": s.get("caption", "") or "",
            "createdAt": s.get("createdAt"),
            "expiresAt": s.get("expiresAt"),
            "user": story_user_public(u),
        })
    out.sort(key=lambda x: int(x.get("createdAt") or 0), reverse=True)
    return out

@app.post("/api/stories")
async def create_story(req: StoryCreate, user: dict = Depends(get_current_user)):
    img = (req.image or "").strip()
    if not img or not isinstance(img, str) or not img.startswith("data:image"):
        raise HTTPException(status_code=400, detail="Imagen inválida")

    # guard (para evitar JSON gigantes)
    if len(img) > 2_500_000:
        raise HTTPException(status_code=413, detail="Imagen demasiado grande")

    cap = (req.caption or "").strip()
    t = now_ms()
    story = {
        "id": str(uuid.uuid4()),
        "userId": user["id"],
        "image": img,
        "caption": cap[:300],
        "createdAt": t,
        "expiresAt": t + STORY_TTL_MS
    }

    stories = load_stories_clean()
    stories.append(story)
    save_json(STORIES_FILE, stories)

    await manager.broadcast({"type": "stories_updated"})
    return {"message": "OK", "storyId": story["id"]}

# --- ADMIN ENDPOINTS ---

@app.get("/api/admin/all_users")
async def admin_list(user: dict = Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, detail="Forbidden")
    users = load_json(USERS_FILE, [])
    return [{k:v for k,v in u.items() if k != "password"} for u in users]


@app.post("/api/admin/users/{uid}/toggle_ban")
async def toggle_ban(uid: str, user: dict = Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, detail="Forbidden")
    if uid == user["id"]:
        raise HTTPException(400, detail="No puedes banearte a ti mismo")

    users = load_json(USERS_FILE, [])
    for i, u in enumerate(users):
        if u["id"] == uid:
            users[i]["is_banned"] = not u.get("is_banned", False)
            save_json(USERS_FILE, users)

            if users[i]["is_banned"]:
                await manager.send_personal_message({"type": "banned"}, uid)
                await asyncio.sleep(0.2)

                to_del = [k for k, v in sessions.items() if v == uid]
                for k in to_del:
                    del sessions[k]

                await manager.close_all_for_user(uid)
                await manager.broadcast({"type": "user_status", "userId": uid, "status": "offline"})

            return {"status": users[i]["is_banned"]}

    raise HTTPException(404, detail="No encontrado")


@app.delete("/api/admin/users/{uid}")
async def delete_user(uid: str, user: dict = Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, detail="Forbidden")
    if uid == user["id"]:
        raise HTTPException(400, detail="No puedes borrar tu propia cuenta")

    users = load_json(USERS_FILE, [])
    initial_len = len(users)
    users = [u for u in users if u["id"] != uid]

    if len(users) == initial_len:
        raise HTTPException(404, detail="Usuario no encontrado")

    save_json(USERS_FILE, users)

    to_del = [k for k, v in sessions.items() if v == uid]
    for k in to_del:
        del sessions[k]

    await manager.close_all_for_user(uid)
    await manager.broadcast({"type": "user_status", "userId": uid, "status": "offline"})

    return {"message": "Usuario eliminado"}


@app.delete("/api/admin/chats/{cid}")
async def admin_delete_chat(cid: str, user: dict = Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, detail="Forbidden")

    chats = load_json(CHATS_FILE, [])
    idx = next((i for i, c in enumerate(chats) if c.get("id") == cid), -1)
    if idx == -1:
        raise HTTPException(404, detail="Chat no encontrado")

    participants = chats[idx].get("participants", [])[:]
    del chats[idx]
    save_json(CHATS_FILE, chats)

    payload = {"type": "chat_deleted", "chatId": cid}
    for p in participants:
        await manager.send_personal_message(payload, p)

    return {"message": "Chat eliminado", "chatId": cid}


@app.get("/api/chats")
async def get_chats(user: dict = Depends(get_current_user)):
    chats = load_json(CHATS_FILE, [])
    res = []

    for c in chats:
        if user["id"] in c.get("participants", []):
            other_id = next((p for p in c["participants"] if p != user["id"]), None)
            other = get_user_by_id(other_id) if other_id else None
            if not other:
                continue

            is_online = manager.is_online(other["id"])
            last = c["messages"][-1] if c.get("messages") else None

            res.append({
                "id": c["id"],
                "otherUser": {
                    "id": other["id"],
                    "name": other.get("name",""),
                    "avatarSeed": other.get("avatarSeed",""),
                    "status": "Suspendido" if other.get("is_banned") else ("En línea" if is_online else "Desconectado"),
                    "is_online": is_online
                },
                "lastMessage": last,
                "unread": 0
            })
    return res


@app.post("/api/chats")
async def create_chat(req: CreateChatRequest, user: dict = Depends(get_current_user)):
    if req.target_user_id == user["id"]:
        raise HTTPException(400, detail="No puedes chatear contigo")

    target = get_user_by_id(req.target_user_id)
    if not target or (target.get("is_banned") and not user.get("is_admin")):
        raise HTTPException(404, detail="Usuario no disponible")

    chats = load_json(CHATS_FILE, [])
    for c in chats:
        if user["id"] in c.get("participants", []) and req.target_user_id in c.get("participants", []):
            return {"id": c["id"], "messages": c.get("messages", [])}

    new_chat = {
        "id": str(uuid.uuid4()),
        "participants": [user["id"], req.target_user_id],
        "messages": []
    }
    chats.append(new_chat)
    save_json(CHATS_FILE, chats)
    return {"id": new_chat["id"], "messages": []}


@app.get("/api/chats/{cid}/messages")
async def get_msgs(cid: str, user: dict = Depends(get_current_user)):
    chats = load_json(CHATS_FILE, [])
    c = next((x for x in chats if x.get("id") == cid), None)
    if not c or user["id"] not in c.get("participants", []):
        raise HTTPException(404, detail="No encontrado")
    return c.get("messages", [])


@app.websocket("/ws/{uid}")
async def ws_endpoint(websocket: WebSocket, uid: str):
    token = websocket.cookies.get("session_token")
    if not token or token not in sessions or sessions[token] != uid:
        try:
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    u = get_user_by_id(uid)
    if not u or u.get("is_banned", False):
        try:
            await websocket.close(code=1008)
        except Exception:
            pass
        return

    await manager.connect(websocket, uid)
    await manager.send_presence_snapshot(websocket)
    await manager.broadcast({"type": "user_status", "userId": uid, "status": "online"})

    try:
        while True:
            data = await websocket.receive_json()
            t = data.get("type")

            # --- Lógica auxiliar para WEBRTC / LLAMADAS ---
            if t in ["call_invite", "call_accept", "call_decline", "call_busy", 
                     "call_hangup", "webrtc_offer", "webrtc_answer", "webrtc_ice", "call_mute_state"]:
                
                chatId = data.get("chatId")
                if not chatId:
                    continue
                
                # Cargar chats para validar y encontrar al 'otro'
                chats = load_json(CHATS_FILE, [])
                chat = next((c for c in chats if c.get("id") == chatId), None)
                
                if chat and uid in chat.get("participants", []):
                    other_id = next((p for p in chat["participants"] if p != uid), None)
                    
                    if other_id:
                        # Para CALL_INVITE, podemos comprobar si está online primero
                        if t == "call_invite":
                            if not manager.is_online(other_id):
                                await manager.send_personal_message({
                                    "type": "call_unavailable",
                                    "chatId": chatId,
                                    "reason": "offline"
                                }, uid)
                                continue

                        # Reenviar el mensaje tal cual al otro usuario
                        # Añadimos fromId para que sepa quién lo manda
                        payload = data.copy()
                        payload["fromId"] = uid
                        await manager.send_personal_message(payload, other_id)

            elif t == "send_message":
                cid = data.get("chatId")
                txt = data.get("text")
                if not cid or not txt:
                    continue

                chats = load_json(CHATS_FILE, [])
                idx = next((i for i, c in enumerate(chats) if c.get("id") == cid), -1)
                if idx == -1:
                    continue

                if uid not in chats[idx].get("participants", []):
                    continue

                kind = data.get("kind")
                duration = data.get("duration")
                peaks = data.get("peaks")

                msg: Dict[str, Any] = {
                    "id": int(time.time() * 1000),
                    "fromId": uid,
                    "text": txt,
                    "time": time.strftime("%H:%M"),
                }

                # Reply-to: solo aceptamos id y resolvemos en servidor
                reply_to = data.get("replyTo")
                if isinstance(reply_to, dict) and reply_to.get("id") is not None:
                    rid = str(reply_to.get("id"))
                    target = None
                    for m in chats[idx].get("messages", []):
                        if str(m.get("id")) == rid:
                            target = m
                            break
                    if target:
                        msg["replyTo"] = {
                            "id": target.get("id"),
                            "fromId": target.get("fromId"),
                            "text": target.get("text"),
                            "kind": target.get("kind"),
                        }

                if kind:
                    msg["kind"] = kind
                else:
                    if isinstance(txt, str) and txt.startswith("data:audio"):
                        msg["kind"] = "audio"
                    elif isinstance(txt, str) and txt.startswith("data:image"):
                        msg["kind"] = "image"

                if msg.get("kind") == "audio":
                    if isinstance(duration, (int, float)):
                        msg["duration"] = int(duration)
                    if isinstance(peaks, list):
                        clean = []
                        for v in peaks:
                            try:
                                iv = int(v)
                                if iv < 0: iv = 0
                                if iv > 1000: iv = 1000
                                clean.append(iv)
                            except Exception:
                                continue
                        msg["peaks"] = clean[:128]

                msg.setdefault("reactions", {})

                chats[idx].setdefault("messages", []).append(msg)
                save_json(CHATS_FILE, chats)

                payload = {"type": "new_message", "chatId": cid, "message": msg}
                for p in chats[idx].get("participants", []):
                    await manager.send_personal_message(payload, p)

            elif t == "react_message":
                cid = data.get("chatId")
                mid = data.get("messageId")
                reaction = data.get("reaction") or "heart"

                if not cid or mid is None:
                    continue

                chats = load_json(CHATS_FILE, [])
                chat = next((c for c in chats if c.get("id") == cid), None)
                if not chat:
                    continue

                if uid not in chat.get("participants", []):
                    continue

                target = None
                for m in chat.get("messages", []):
                    if str(m.get("id")) == str(mid):
                        target = m
                        break

                if not target:
                    continue

                target.setdefault("reactions", {})
                target["reactions"].setdefault(reaction, [])

                lst = target["reactions"][reaction]
                active = False
                if uid in lst:
                    lst.remove(uid)
                    active = False
                else:
                    lst.append(uid)
                    active = True

                save_json(CHATS_FILE, chats)

                payload = {
                    "type": "message_reaction",
                    "chatId": cid,
                    "messageId": target.get("id"),
                    "reaction": reaction,
                    "userId": uid,
                    "active": active,
                    "reactions": target.get("reactions", {})
                }

                for p in chat.get("participants", []):
                    await manager.send_personal_message(payload, p)

            elif t in ("typing", "typing_status", "is_typing"):
                cid = data.get("chatId")
                is_typing = bool(
                    data.get("isTyping") if "isTyping" in data else
                    data.get("is_typing") if "is_typing" in data else
                    data.get("typing") if "typing" in data else
                    False
                )

                chats = load_json(CHATS_FILE, [])
                chat = next((c for c in chats if c.get("id") == cid), None)
                if not chat:
                    continue

                payload = {
                    "type": "typing_status",
                    "chatId": cid,
                    "fromId": uid,
                    "isTyping": is_typing
                }
                for p in chat.get("participants", []):
                    if p != uid:
                        await manager.send_personal_message(payload, p)

    except Exception:
        pass
    finally:
        still_online = await manager.disconnect(websocket, uid)
        if not still_online:
            await manager.broadcast({"type": "user_status", "userId": uid, "status": "offline"})


@app.get("/{path:path}")
async def serve_static(path: str):
    # API/Auth guards
    if path.startswith(("api/", "auth/", "ws/")):
        return JSONResponse({"error": "Not found"}, status_code=404)

    # Construct file path
    file_path = os.path.join(PUBLIC_DIR, path)

    # If path is empty, serve index.html
    if path == "" or path == "/":
        return FileResponse(os.path.join(PUBLIC_DIR, "index.html"))

    # If file exists and is a file, serve it (CSS, JS, assets)
    if os.path.isfile(file_path):
        return FileResponse(file_path)

    # SPA Fallback -> index.html
    return FileResponse(os.path.join(PUBLIC_DIR, "index.html"))
