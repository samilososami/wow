let currentUser = null;
let activeChatId = null;
let activeChatUserId = null;
let ws = null;
let userChats = [];
let allUsers = [];
let pendingImage = null;
let userToDelete = null;

// --- ESTADO DE LLAMADAS (WebRTC) ---
let callState = 'idle'; // idle, calling, ringing, incall
let pc = null; // RTCPeerConnection
let localStream = null;
let remoteStream = null;
let currentCallChatId = null;
let currentCallMode = null; // 'audio' | 'video'
let isCaller = false;
let iceCandidatesQueue = [];

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- ESTADO DE PRESENCIA / TIPADO ---
const onlineUsers = {};
const typingByChat = {};
let typingStopTimer = null;
let lastTypingSentAt = 0;

// --- ESTADO DE RESPUESTA ---
let replyingToMessage = null; // { id, text, name }

// --- CACHÉ DE REACCIONES ---
const reactionsByMessageId = {}; // { messageId: {heart:[userIds]} }

// --- REPRODUCTORES DE AUDIO ---
const audioPlayers = {}; // { messageId: { audio, peaks, canvas, timeEl, playing, raf } }

// --- GRABACIÓN DE VOZ ---
let isRecording = false;
let recMode = null;      // 'mediarecorder' | 'webaudio'
let recCanceled = false;
let recStream = null;

// MediaRecorder
let recRecorder = null;
let recChunks = [];

// WebAudio fallback (PCM -> WAV)
let recAudioCtx = null;
let recSource = null;
let recProcessor = null;
let recGain = null;
let recPCMChunks = [];
let recInputSampleRate = 48000;

// UI/timing
let recStartedAt = 0;
let recTick = null;

// Peaks
let recAnalyser = null;
let recAnalyserData = null;
let recPeaksRaw = [];

// Cropper Vars
let cropperImg = null;
let cropperCanvas = null;
let cropperCtx = null;
let cropScale = 1;
let cropPos = { x: 0, y: 0 };
let isDraggingCrop = false;
let dragStart = { x: 0, y: 0 };
let initialPinchDist = 0;
let initialScale = 1;
let cropperZoom = 1;

// Story Vars
let pendingStoryImg = null;

document.addEventListener('DOMContentLoaded', () => {
  refreshIcons();
  checkSession();

  const ta = document.getElementById('message-input');
  if (ta) {
    ta.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
      if (this.value === '') this.style.height = 'auto';

      toggleSendButton();
      emitTypingSmart();
    });

    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // Cropper events
  const canvas = document.getElementById('crop-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', startDrag);
    canvas.addEventListener('mousemove', onDrag);
    canvas.addEventListener('mouseup', endDrag);
    canvas.addEventListener('mouseleave', endDrag);
    canvas.addEventListener('touchstart', handleTouchStart, {passive: false});
    canvas.addEventListener('touchmove', handleTouchMove, {passive: false});
    canvas.addEventListener('touchend', endDrag);
    canvas.addEventListener('wheel', onWheel, {passive:false});
  }
});

function refreshIcons() { if (typeof lucide !== 'undefined') lucide.createIcons(); }

function getBaseUrl(url) {
  if (!url.startsWith('http') && (window.location.protocol === 'file:' || window.location.protocol === 'blob:' || window.location.origin === 'null')) {
    return 'http://localhost:8000' + url;
  }
  return url;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function getAvatarUrl(seed) {
  if (seed && seed.startsWith('data:')) return seed;
  return `https://api.dicebear.com/9.x/avataaars/svg?seed=${seed}&backgroundColor=c0aede`;
}

function showToast(msg, type = 'normal') {
    const toast = document.getElementById('toast');
    const icon = toast.querySelector('i');
    const text = document.getElementById('toast-msg');

    text.innerText = msg;
    toast.className = 'toast-notification';

    if (type === 'error') {
        toast.classList.add('error');
        icon.setAttribute('data-lucide', 'ban');
    } else {
        icon.setAttribute('data-lucide', 'info');
    }

    refreshIcons();
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- AUTH & API ---
async function apiCall(url, method="GET", body=null) {
    let fetchUrl = getBaseUrl(url);
    const opts = { method: method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    try {
        const res = await fetch(fetchUrl, opts);
        if (res.status === 401) { showLogin(); return null; }
        if (res.status === 403) { currentUser = null; showLogin(); return null; }
        if (!res.ok) {
            if (method === 'POST' && url.includes('change-password')) return null;
            if (url.includes('register')) return await res.json();
            throw new Error('API Error');
        }
        return await res.json();
    } catch (e) {
        console.warn("Fetch Warning:", e);
        return null;
    }
}

async function checkSession() {
  const user = await apiCall('/api/me');
  if (user) { currentUser = user; hideLogin(); initApp(); }
  else { showLogin(); }
}

function showLogin() {
  const v = document.getElementById('login-view');
  v.classList.remove('hidden');
  v.style.opacity = '1';
  toggleRegisterView(false);
  try { if (ws) ws.close(); } catch {}
  ws = null;
}

function hideLogin() {
  const v = document.getElementById('login-view');
  v.style.opacity = '0';
  setTimeout(() => v.classList.add('hidden'), 500);
}

// --- LOGIN & REGISTER LOGIC ---
function toggleRegisterView(showRegister) {
    const loginForm = document.getElementById('login-form');
    const regForm = document.getElementById('register-form');

    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('reg-name').value = '';
    document.getElementById('reg-username').value = '';
    document.getElementById('reg-password').value = '';
    document.getElementById('login-error').innerText = '';
    document.getElementById('reg-error').innerText = '';

    if (showRegister) {
        loginForm.classList.remove('visible-form');
        loginForm.classList.add('hidden-form');
        regForm.classList.remove('hidden-form');
        regForm.classList.add('visible-form');
    } else {
        regForm.classList.remove('visible-form');
        regForm.classList.add('hidden-form');
        loginForm.classList.remove('hidden-form');
        loginForm.classList.add('visible-form');
    }
}

async function login() {
  const u = document.getElementById('login-username').value.trim();
  const p = document.getElementById('login-password').value.trim();
  const err = document.getElementById('login-error'); err.innerText = "";
  try {
    const res = await fetch(getBaseUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (res.ok) { currentUser = data.user; hideLogin(); initApp(); }
    else if (res.status === 403) { err.innerText = "Cuenta suspendida. Contacta a administración."; }
    else { err.innerText = "Credenciales incorrectas"; }
  } catch (e) {
    err.innerText = "Error de conexión";
  }
}

async function register() {
    const name = document.getElementById('reg-name').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value.trim();
    const err = document.getElementById('reg-error'); err.innerText = "";

    if (!name || !username || !password) {
        err.innerText = "Por favor, completa todos los campos.";
        return;
    }

    try {
        const res = await fetch(getBaseUrl('/auth/register'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, name, password })
        });
        const data = await res.json();

        if (res.ok) {
            currentUser = data.user;
            hideLogin();
            initApp();
        } else {
            err.innerText = data.detail || "Error al registrarse";
        }
    } catch (e) {
        err.innerText = "Error de conexión";
    }
}

function handleLoginKey(e) { if (e.key === 'Enter') login(); }
async function logout() { await apiCall('/auth/logout', 'POST'); window.location.reload(); }

function initApp() {
  updateProfileUI();
  applyTheme();
  updateToggleUI();
  loadChats();

  if (currentUser.is_admin) {
    document.getElementById('nav-btn-admin').classList.remove('hidden');
    document.getElementById('nav-btn-admin').classList.add('flex');
    document.getElementById('profile-admin-badge').classList.remove('hidden');
    document.getElementById('profile-admin-banner').classList.remove('hidden');
  }

  connectWS();
}

function connectWS() {
  if (!currentUser) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const wsUrl = (window.location.protocol === 'file:' || window.location.protocol === 'blob:' || window.location.origin === 'null')
    ? `ws://localhost:8000/ws/${currentUser.id}`
    : `${window.location.protocol==='https:'?'wss':'ws'}://${window.location.host}/ws/${currentUser.id}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("WS Connected");
      updateChatHeaderPresence();
    };

    ws.onmessage = async (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch { return; }

      // --- LOGICA DE LLAMADAS (WEBRTC) ---
      if (['call_invite', 'call_accept', 'call_decline', 'call_busy', 'call_hangup', 'call_unavailable', 'webrtc_offer', 'webrtc_answer', 'webrtc_ice'].includes(data.type)) {
          handleSignalingData(data);
          return;
      }

      if (data.type === 'banned') { handleBan(); return; }

      if (data.type === 'chat_deleted') {
          if (activeChatId === data.chatId) closeChat();
          loadChats();
          showToast("Este chat ha sido eliminado por un administrador", "normal");
          return;
      }

      if (data.type === 'stories_updated') {
         if (document.getElementById('tab-stories').classList.contains('tab-active')) {
             loadStories();
         }
         return;
      }

      if (data.type === 'presence_snapshot' && Array.isArray(data.onlineUserIds)) {
        data.onlineUserIds.forEach(uid => { onlineUsers[String(uid)] = true; });
        loadChats();
        updateChatHeaderPresence();
        return;
      }

      if (data.type === 'new_message') { handleIncomingMessage(data); return; }
      if (data.type === 'message_reaction') { handleReactionUpdate(data); return; }

      if (data.type === 'user_status' || data.type === 'presence' || data.type === 'online_status') {
        const uid = data.userId ?? data.user_id ?? data.uid ?? data.id;
        const statusRaw = data.status ?? data.state ?? data.presence ?? data.online;
        const isOnline = statusRaw === true || statusRaw === 'online' || statusRaw === 'connected' || statusRaw === 1;

        if (uid != null) onlineUsers[String(uid)] = !!isOnline;

        if (activeChatUserId && String(uid) === String(activeChatUserId)) updateChatHeaderPresence();
        loadChats();
        return;
      }

      if (data.type === 'typing_status' || data.type === 'typing' || data.type === 'is_typing') {
        const cid = data.chatId ?? data.chat_id ?? data.cid;
        if (cid == null) return;

        const isTyping = data.isTyping ?? data.is_typing ?? data.typing ?? data.value ?? false;
        typingByChat[String(cid)] = !!isTyping;

        if (activeChatId && String(cid) === String(activeChatId)) setRemoteTyping(!!isTyping);
        return;
      }
    };

    ws.onclose = () => {
      updateChatHeaderPresence();
      setTimeout(connectWS, 1200);
    };
  } catch (e) {
    console.warn("WS Error", e);
  }
}

// ============================================
// LOGICA DE LLAMADAS Y WEBRTC
// ============================================

async function startCall(mode) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        showToast("Sin conexión", "error");
        return;
    }
    if (!activeChatId || !activeChatUserId) return;
    if (callState !== 'idle') {
        showToast("Ya tienes una llamada en curso", "error");
        return;
    }

    currentCallMode = mode;
    currentCallChatId = activeChatId;
    isCaller = true;
    callState = 'calling';

    // Obtener info del usuario para mostrar en el overlay
    const name = document.getElementById('chat-header-name').innerText;
    const avatar = document.getElementById('chat-header-img').src;

    showCallOverlay(name, avatar, "Llamando...", mode);

    // Enviar invitación
    ws.send(JSON.stringify({
        type: 'call_invite',
        chatId: activeChatId,
        mode: mode
    }));
}

async function handleSignalingData(data) {
    switch (data.type) {
        case 'call_invite':
            if (callState !== 'idle') {
                // Estamos ocupados
                ws.send(JSON.stringify({ type: 'call_busy', chatId: data.chatId }));
                return;
            }
            // Comprobar si es el chat activo o no (podríamos aceptar llamadas de otros chats, pero simplificamos)
            // Si quieres aceptar de cualquiera, carga los datos del usuario 'fromId'
            
            // Mostrar UI de llamada entrante
            callState = 'ringing';
            currentCallChatId = data.chatId;
            currentCallMode = data.mode;
            isCaller = false;

            // Buscamos quién nos llama (puede estar en userChats o allUsers)
            // Para simplificar, si estamos en el chat, usamos la UI actual, si no, intentamos resolver el nombre
            let callerName = "Usuario";
            let callerImg = "";
            
            // Intentamos buscarlo en los chats
            const chat = userChats.find(c => c.id === data.chatId);
            if(chat) {
                callerName = chat.otherUser.name;
                callerImg = getAvatarUrl(chat.otherUser.avatarSeed);
            }

            // Preguntar al usuario (simulado con el overlay y botones específicos)
            showIncomingCallUI(callerName, callerImg, data.mode);
            break;

        case 'call_accept':
            if (callState === 'calling') {
                callState = 'incall';
                updateCallStatus("Conectando...");
                // Iniciar WebRTC como Caller
                await setupPeerConnection();
                // Crear oferta
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    ws.send(JSON.stringify({
                        type: 'webrtc_offer',
                        chatId: currentCallChatId,
                        sdp: pc.localDescription
                    }));
                } catch (e) {
                    console.error("Error creating offer", e);
                    endCall();
                }
            }
            break;

        case 'call_decline':
            showToast("Llamada rechazada", "normal");
            endCall(false); // false = no enviar hangup porque ya terminaron
            break;

        case 'call_busy':
            showToast("El usuario está ocupado", "error");
            endCall(false);
            break;

        case 'call_unavailable':
             showToast("Usuario no disponible (Offline)", "error");
             endCall(false);
             break;

        case 'call_hangup':
            showToast("Llamada finalizada", "normal");
            endCall(false);
            break;

        case 'webrtc_offer':
            if (callState === 'incall' || callState === 'ringing') { // 'ringing' si aceptamos rápido
                callState = 'incall';
                if (!pc) await setupPeerConnection();
                
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                    // Procesar candidatos en cola
                    while (iceCandidatesQueue.length) {
                        await pc.addIceCandidate(iceCandidatesQueue.shift());
                    }

                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    
                    ws.send(JSON.stringify({
                        type: 'webrtc_answer',
                        chatId: currentCallChatId,
                        sdp: pc.localDescription
                    }));
                } catch (e) {
                    console.error("Error handling offer", e);
                }
            }
            break;

        case 'webrtc_answer':
            if (pc && callState === 'incall') {
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                } catch (e) {
                    console.error("Error setting remote description", e);
                }
            }
            break;

        case 'webrtc_ice':
            if (pc && callState === 'incall') {
                const candidate = new RTCIceCandidate(data.candidate);
                if (pc.remoteDescription) {
                    try {
                        await pc.addIceCandidate(candidate);
                    } catch (e) { console.error("Error adding ICE", e); }
                } else {
                    iceCandidatesQueue.push(candidate);
                }
            }
            break;
    }
}

async function setupPeerConnection() {
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'webrtc_ice',
                chatId: currentCallChatId,
                candidate: event.candidate
            }));
        }
    };

    pc.ontrack = (event) => {
        const remoteVideo = document.getElementById('remoteVideo');
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            updateCallStatus(""); // Quitar texto de "Conectando"
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            endCall();
        }
    };

    // Obtener media local
    try {
        const constraints = {
            audio: true,
            video: currentCallMode === 'video' ? { facingMode: 'user' } : false
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = localStream;
        // Si es solo audio, ocultar video local
        if (currentCallMode === 'audio') {
            localVideo.classList.add('hidden');
        } else {
            localVideo.classList.remove('hidden');
        }

        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    } catch (e) {
        console.error("Error accessing media devices", e);
        showToast("Error acceso a cámara/micrófono", "error");
        endCall();
    }
}

function showCallOverlay(name, avatar, status, mode) {
    const overlay = document.getElementById('view-call-overlay');
    const nameEl = document.getElementById('call-name');
    const statusEl = document.getElementById('call-status-text');
    const avatarEl = document.getElementById('call-avatar');
    
    // Resetear UI
    document.getElementById('remoteVideo').srcObject = null;
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('call-mute-btn').classList.remove('bg-red-500');
    
    nameEl.innerText = name;
    statusEl.innerText = status;
    avatarEl.src = avatar;

    overlay.classList.remove('hidden');
    overlay.classList.add('flex'); // Usamos flex para centrar
}

function showIncomingCallUI(name, avatar, mode) {
    // Reutilizamos el overlay pero cambiamos botones o mostramos un modal
    // Para simplificar, modificamos el overlay para que tenga botones de aceptar/rechazar
    // O usamos el navegador nativo confirm (muy feo), mejor inyectamos HTML temporalmente
    
    const overlay = document.getElementById('view-call-overlay');
    overlay.innerHTML = `
        <div class="absolute inset-0 bg-black/90 flex flex-col items-center justify-center text-white z-50 animate-fade-in">
             <img src="${avatar}" class="w-24 h-24 rounded-full border-4 border-white/20 mb-4 animate-pulse-ring">
             <h3 class="text-2xl font-bold mb-1">${escapeHtml(name)}</h3>
             <p class="text-sm opacity-80 mb-12">Llamada ${mode === 'video' ? 'de Video' : 'de Audio'} Entrante...</p>
             
             <div class="flex gap-10 items-center">
                 <button onclick="declineIncomingCall()" class="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white hover:scale-110 transition-transform shadow-lg shadow-red-500/30">
                    <i data-lucide="phone-off" class="w-8 h-8"></i>
                 </button>
                 <button onclick="acceptIncomingCall()" class="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center text-white hover:scale-110 transition-transform shadow-lg shadow-green-500/30">
                    <i data-lucide="phone" class="w-8 h-8"></i>
                 </button>
             </div>
        </div>
    `;
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    refreshIcons();
}

// Restaurar el HTML original del overlay cuando se acepte o termine
function restoreOverlayHTML() {
    const overlay = document.getElementById('view-call-overlay');
    overlay.innerHTML = `
        <video id="remoteVideo" autoplay playsinline class="remote-video"></video>
        <video id="localVideo" autoplay playsinline muted class="local-video"></video>
        <div id="call-status-ui" class="absolute top-20 flex flex-col items-center text-white z-20">
             <img id="call-avatar" src="" class="w-24 h-24 rounded-full border-4 border-white/20 mb-4 shadow-xl">
             <h3 id="call-name" class="text-2xl font-bold text-shadow">Usuario</h3>
             <p id="call-status-text" class="text-sm font-medium opacity-80 animate-pulse">Conectando...</p>
        </div>
        <div class="call-controls absolute bottom-12 flex items-center gap-6 z-30">
             <button id="call-mute-btn" onclick="toggleMute()" class="w-14 h-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/30 transition-all">
                <i id="call-mute-icon" data-lucide="mic" class="w-6 h-6"></i>
             </button>
             <button onclick="endCall()" class="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white shadow-lg shadow-red-500/40 hover:scale-105 transition-all">
                <i data-lucide="phone-off" class="w-8 h-8"></i>
             </button>
             <button id="call-video-toggle" onclick="toggleVideo()" class="w-14 h-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/30 transition-all">
                 <i id="call-video-icon" data-lucide="video" class="w-6 h-6"></i>
             </button>
        </div>
    `;
    refreshIcons();
}

function acceptIncomingCall() {
    restoreOverlayHTML(); // Restaurar UI normal
    
    // Configurar UI con datos
    // Necesitamos recuperar nombre/avatar de nuevo o guardarlo en variables globales temporales
    // Simplificación: Lo dejamos genérico o lo sacamos del chat si lo tenemos
    const chat = userChats.find(c => c.id === currentCallChatId);
    if(chat) {
        showCallOverlay(chat.otherUser.name, getAvatarUrl(chat.otherUser.avatarSeed), "Conectando...", currentCallMode);
    } else {
        showCallOverlay("Usuario", "", "Conectando...", currentCallMode);
    }
    
    callState = 'incall';
    ws.send(JSON.stringify({ type: 'call_accept', chatId: currentCallChatId }));
    
    // Iniciar WebRTC como Callee (esperar oferta)
    // El flujo es: enviamos accept -> caller recibe accept -> caller envía offer -> recibimos offer
}

function declineIncomingCall() {
    ws.send(JSON.stringify({ type: 'call_decline', chatId: currentCallChatId }));
    restoreOverlayHTML();
    endCall(false);
}

function updateCallStatus(text) {
    const el = document.getElementById('call-status-text');
    if(el) el.innerText = text;
}

function toggleMute() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            
            const btn = document.getElementById('call-mute-btn');
            const icon = document.getElementById('call-mute-icon');
            
            if (!audioTrack.enabled) {
                btn.classList.add('bg-red-500', 'hover:bg-red-600');
                btn.classList.remove('bg-white/20', 'hover:bg-white/30');
                icon.setAttribute('data-lucide', 'mic-off');
            } else {
                btn.classList.remove('bg-red-500', 'hover:bg-red-600');
                btn.classList.add('bg-white/20', 'hover:bg-white/30');
                icon.setAttribute('data-lucide', 'mic');
            }
            refreshIcons();
        }
    }
}

function toggleVideo() {
    if (localStream) {
         const videoTrack = localStream.getVideoTracks()[0];
         if (videoTrack) {
             videoTrack.enabled = !videoTrack.enabled;
             const icon = document.getElementById('call-video-icon');
             icon.setAttribute('data-lucide', videoTrack.enabled ? 'video' : 'video-off');
             refreshIcons();
         } else if (currentCallMode === 'audio') {
             showToast("Llamada solo de audio", "normal");
         }
    }
}

function endCall(sendSignal = true) {
    if (sendSignal && currentCallChatId && ws) {
        ws.send(JSON.stringify({ type: 'call_hangup', chatId: currentCallChatId }));
    }

    if (pc) {
        pc.close();
        pc = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    
    callState = 'idle';
    currentCallChatId = null;
    currentCallMode = null;
    iceCandidatesQueue = [];

    // Ocultar Overlay
    const overlay = document.getElementById('view-call-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    
    // Asegurar que el HTML está limpio para la próxima
    restoreOverlayHTML();
}

// ============================================
// FIN LÓGICA DE LLAMADAS
// ============================================

function handleBan() {
    currentUser = null;
    showLogin();
    const alert = document.getElementById('ban-alert-popup');
    alert.classList.add('show');
    setTimeout(() => { alert.classList.remove('show'); }, 3200);
}

async function loadChats() {
  userChats = await apiCall('/api/chats') || [];
  renderChatList();
}

async function loadPeople() {
  const text = document.getElementById('people-search-input').value;
  allUsers = await apiCall('/api/users') || [];
  renderPeople(text);
}

async function loadStories() {
    const stories = await apiCall('/api/stories') || [];
    const container = document.getElementById('stories-list');
    if (!container) return;

    if (stories.length === 0) {
        container.innerHTML = `<div class="text-center mt-20 text-muted"><p>No hay historias recientes.</p></div>`;
        return;
    }

    container.innerHTML = stories.map(s => {
        const av = getAvatarUrl(s.user.avatarSeed);
        return `
        <div class="story-card bg-black">
            <img src="${s.image}" class="story-img">
            <div class="story-overlay">
                <div class="story-user" onclick="viewOtherProfile('${s.user.id}')">
                    <img src="${av}" class="w-8 h-8 rounded-full border border-white">
                    <span class="text-white font-bold text-sm text-shadow">${escapeHtml(s.user.name)}</span>
                </div>
                ${s.caption ? `<p class="text-white text-sm font-medium drop-shadow-md ml-1">${escapeHtml(s.caption)}</p>` : ''}
            </div>
        </div>`;
    }).join('');
}

async function loadAdminData() {
  if (!currentUser.is_admin) return;
  const users = await apiCall('/api/admin/all_users');
  const container = document.getElementById('admin-user-list');
  if (users && container) {
    container.innerHTML = users.map(u => {
      const isMe = u.id === currentUser.id;
      const highlightClass = isMe ? 'user-highlight' : 'border-slate-100 dark:border-slate-700';

      const banBtnText = u.is_banned ? 'DESBANEAR' : 'BANEAR';
      const banBtnClass = u.is_banned
        ? 'bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-600'
        : 'bg-orange-500 text-white shadow-md hover:bg-orange-600';

      const banIcon = u.is_banned
        ? `<div class="w-6 h-6 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0"><i data-lucide="octagon-alert" class="w-3.5 h-3.5 text-red-500"></i></div>`
        : '';

      return `
        <div class="p-4 bg-bar rounded-xl shadow-sm border ${highlightClass} flex justify-between items-center transition-all cursor-pointer"
             onclick="viewOtherProfile('${u.id}')" style="background-color: var(--bar);">
          <div class="flex items-center gap-3">
            <img src="${getAvatarUrl(u.avatarSeed)}" class="w-10 h-10 rounded-full bg-slate-200 object-cover">
            ${banIcon}
            <div>
              <h3 class="font-bold text-sm text-main flex items-center gap-1">
                ${escapeHtml(u.name)} ${isMe ? '<span class="text-[10px] bg-wow-100 text-wow-600 px-1.5 rounded">TÚ</span>' : ''}
              </h3>
              <p class="text-xs text-muted">@${escapeHtml(u.username)}</p>
            </div>
          </div>
          <div class="flex items-center gap-2" onclick="event.stopPropagation()">
            <div class="text-right hidden sm:block mr-2">
              <p class="text-[10px] text-muted">Unido: ${escapeHtml(u.joined_at || 'N/A')}</p>
            </div>
            ${!isMe ? `<button onclick="toggleBan('${u.id}')" class="rounded-lg ${banBtnClass} transition-all flex items-center gap-1.5 uppercase tracking-wide font-bold text-[10px] py-2 px-3">${banBtnText}</button>` : ''}
            ${!isMe ? `<button onclick="promptDeleteUser('${u.id}')" class="rounded-lg bg-red-100 dark:bg-red-900/20 text-red-500 hover:bg-red-500 hover:text-white transition-all flex items-center justify-center w-8 h-8"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
          </div>
        </div>`;
    }).join('');
    refreshIcons();
  }
}

async function toggleBan(userId) {
  const res = await apiCall(`/api/admin/users/${userId}/toggle_ban`, 'POST');
  if (res) loadAdminData();
}

// --- DELETE LOGIC ---
function promptDeleteUser(userId) {
    userToDelete = userId;
    const modal = document.getElementById('view-delete-confirm');
    const panel = document.getElementById('delete-panel');

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        panel.classList.remove('scale-95');
        panel.classList.add('scale-100');
    }, 10);
}

function closeDeleteModal() {
    const modal = document.getElementById('view-delete-confirm');
    const panel = document.getElementById('delete-panel');

    modal.classList.add('opacity-0');
    panel.classList.remove('scale-100');
    panel.classList.add('scale-95');

    setTimeout(() => { modal.classList.add('hidden'); }, 300);
}

async function doDeleteUser() {
    if (!userToDelete) return;
    const res = await apiCall(`/api/admin/users/${userToDelete}`, 'DELETE');

    if (res) {
        showToast("Usuario eliminado correctamente", "normal");
        userToDelete = null;
        closeDeleteModal();
        switchTab('admin');
    } else {
        showToast("Error al eliminar usuario", "error");
    }
}

// --- DELETE CHAT LOGIC ---
function promptDeleteChat() {
    if (!activeChatId) return;
    const modal = document.getElementById('view-delete-chat-confirm');
    const panel = document.getElementById('delete-chat-panel');

    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        panel.classList.remove('scale-95');
        panel.classList.add('scale-100');
    }, 10);
}

function closeDeleteChatModal() {
    const modal = document.getElementById('view-delete-chat-confirm');
    const panel = document.getElementById('delete-chat-panel');

    modal.classList.add('opacity-0');
    panel.classList.remove('scale-100');
    panel.classList.add('scale-95');

    setTimeout(() => { modal.classList.add('hidden'); }, 300);
}

async function doDeleteChat() {
    if (!activeChatId) return;
    const res = await apiCall(`/api/admin/chats/${activeChatId}`, 'DELETE');
    if (res) {
        showToast("Chat eliminado", "normal");
        closeDeleteChatModal();
        closeChat();
        loadChats();
    } else {
        showToast("Error al eliminar chat", "error");
    }
}

function applyTheme() {
  const c = document.getElementById('app-container');
  if (currentUser.darkMode) c.classList.add('dark'); else c.classList.remove('dark');
  document.documentElement.setAttribute('data-theme', currentUser.theme);
}

function updateToggleUI() {
  const t = document.getElementById('dark-mode-switch');
  if (!t) return;
  if (currentUser.darkMode) t.classList.add('active'); else t.classList.remove('active');
}

function updateProfileUI() {
  const url = getAvatarUrl(currentUser.avatarSeed);
  ['nav-avatar','profile-view-avatar','edit-avatar-img'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.src = url;
  });
  document.getElementById('profile-name').innerText = currentUser.name;
  document.getElementById('profile-username').innerText = "@"+currentUser.username;
  document.getElementById('profile-bio').innerText = currentUser.bio || '';
  document.getElementById('edit-name-input').value = currentUser.name || '';
  document.getElementById('edit-username-input').value = currentUser.username || '';
  document.getElementById('edit-bio-input').value = currentUser.bio || '';
}

function updateChatHeaderPresence() {
  const statusEl = document.getElementById('chat-header-status');
  const dotEl = document.getElementById('chat-header-presence-dot');
  if (!statusEl || !dotEl) return;

  if (!activeChatUserId) {
    statusEl.textContent = '';
    dotEl.classList.remove('bg-green-500','bg-slate-400');
    dotEl.classList.add('bg-slate-400');
    return;
  }

  if (activeChatId && typingByChat[String(activeChatId)]) {
    statusEl.textContent = 'Escribiendo...';
    statusEl.classList.remove('text-wow-500');
    statusEl.classList.add('text-slate-500');

    dotEl.classList.remove('bg-green-500');
    dotEl.classList.add('bg-slate-400');
    return;
  }

  const wsConnected = (ws && ws.readyState === WebSocket.OPEN);
  const isOnline = wsConnected && !!onlineUsers[String(activeChatUserId)];

  statusEl.textContent = isOnline ? 'En línea' : 'Desconectado';
  statusEl.classList.remove('text-slate-500');
  statusEl.classList.add('text-wow-500');

  dotEl.classList.remove('bg-green-500','bg-slate-400');
  dotEl.classList.add(isOnline ? 'bg-green-500' : 'bg-slate-400');
}

function renderChatList() {
  const l = document.getElementById('chat-list'); if (!l) return;
  if (userChats.length === 0) {
    l.innerHTML = `<div class="text-center mt-10 text-muted"><p>No tienes chats activos.</p><button onclick="switchTab('people')" class="mt-4 text-wow-500 font-bold hover:underline">Buscar personas</button></div>`;
    return;
  }

  l.innerHTML = userChats.map(c => {
    const av = getAvatarUrl(c.otherUser.avatarSeed);

    const lastPreview = c.lastMessage ? c.lastMessage.text : 'Empezar chat';
    const preview = (typeof lastPreview === 'string' && lastPreview.startsWith('data:image')) ? '📷 Foto'
                  : (typeof lastPreview === 'string' && lastPreview.startsWith('data:audio')) ? '🎤 Nota de voz'
                  : escapeHtml(lastPreview);

    const wsConnected = (ws && ws.readyState === WebSocket.OPEN);
    const isOnline = wsConnected && (c.otherUser.is_online === true || onlineUsers[String(c.otherUser.id)] === true);

    const st = c.otherUser.status === 'Suspendido'
      ? '<span class="text-red-500 text-[10px] font-bold">SUSPENDIDO</span>'
      : (isOnline ? 'En línea' : (c.lastMessage ? c.lastMessage.time : ""));

    return `
      <div onclick="openChat('${c.id}','${c.otherUser.id}','${escapeHtml(c.otherUser.name)}','${escapeHtml(c.otherUser.avatarSeed)}')"
           class="flex items-center gap-4 px-6 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer transition-theme border-b border-theme last:border-0"
           style="border-color: var(--border);">
        <div class="relative">
          <img src="${av}" class="w-[56px] h-[56px] rounded-full object-cover bg-slate-100 shadow-sm border border-theme transition-theme" style="border-color: var(--border);">
          <div class="absolute bottom-1 right-1 w-2.5 h-2.5 ${isOnline ? 'bg-green-500' : 'bg-slate-300'} border-2 border-theme rounded-full" style="border-color: var(--panel);"></div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex justify-between items-baseline mb-1">
            <h3 class="font-bold text-main truncate text-[16px] transition-theme">${escapeHtml(c.otherUser.name)}</h3>
            <span class="text-[11px] font-semibold text-muted transition-theme">${st}</span>
          </div>
          <div class="flex justify-between items-center">
            <p class="text-[14px] truncate pr-3 text-muted transition-theme">${preview}</p>
          </div>
        </div>
      </div>`;
  }).join('');

  refreshIcons();
}

function renderPeople(ft="") {
  const c = document.getElementById('people-grid'); if (!c) return;
  const q = ft.toLowerCase();
  const f = allUsers.filter(u => (u.name||'').toLowerCase().includes(q) || (u.username||'').toLowerCase().includes(q));
  if (f.length === 0) { c.innerHTML = `<div class="col-span-2 text-center text-muted mt-10"><p>No se encontraron resultados</p></div>`; return; }
  c.innerHTML = f.map(u => `
    <div class="flex flex-col items-center bg-bar p-5 rounded-[24px] hover:bg-white dark:hover:bg-slate-800 shadow-sm transition-theme cursor-pointer border border-theme"
         style="background-color: var(--bar); border-color: var(--border);" onclick="viewOtherProfile('${u.id}')">
      <img src="${getAvatarUrl(u.avatarSeed)}" class="w-16 h-16 rounded-full mb-3 bg-slate-200 transition-transform duration-300 shadow-md transition-theme object-cover">
      <h3 class="font-bold text-sm text-main text-center truncate w-full mb-0.5 transition-theme">${escapeHtml(u.name)}</h3>
      <p class="text-xs text-muted mb-3 transition-theme">@${escapeHtml(u.username)}</p>
      <button onclick="event.stopPropagation(); startChat('${u.id}')" class="w-full py-2 bg-wow-100 dark:bg-slate-700 text-wow-600 dark:text-white text-xs font-bold rounded-xl hover:bg-wow-500 hover:text-white dark:hover:bg-wow-500 transition-all transition-theme">Mensaje</button>
    </div>
  `).join('');
  refreshIcons();
}

function filterPeople() {
  const i = document.getElementById('people-search-input');
  if (i) renderPeople(i.value);
}

async function viewOtherProfile(uid) {
  const u = await apiCall(`/api/users/${uid}`);
  if (!u) return;

  document.getElementById('other-profile-name').innerText = u.name || '';
  document.getElementById('other-profile-username').innerText = "@"+(u.username||'');
  document.getElementById('other-profile-bio').innerText = u.bio || "Sin biografía";
  document.getElementById('other-profile-avatar').src = getAvatarUrl(u.avatarSeed);

  const badge = document.getElementById('other-profile-admin-badge');
  const banner = document.getElementById('other-profile-admin-banner');

  if (badge && banner) {
    if (u.is_admin) { badge.classList.remove('hidden'); banner.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); banner.classList.add('hidden'); }
  }

  document.getElementById('view-other-profile').classList.remove('hidden');
  refreshIcons();
}

function viewOtherProfileFromChat() { if (activeChatUserId) viewOtherProfile(activeChatUserId); }
function closeOtherProfile() { document.getElementById('view-other-profile').classList.add('hidden'); }

async function startChat(tid) {
  const r = await apiCall('/api/chats', 'POST', { target_user_id: tid });
  if (r) {
    await loadChats();
    const u = allUsers.find(x => x.id === tid);
    if (u) openChat(r.id, u.id, u.name, u.avatarSeed);
  }
}

async function openChat(cid, oid, n, seed) {
  activeChatId = cid;
  activeChatUserId = oid;

  cancelReplyMode();

  document.getElementById('chat-header-name').innerText = n;
  document.getElementById('chat-header-img').src = getAvatarUrl(seed);

  // Admin delete button toggle
  const delBtn = document.getElementById('chat-delete-btn');
  if (currentUser && currentUser.is_admin) {
      delBtn.classList.remove('hidden');
  } else {
      delBtn.classList.add('hidden');
  }

  typingByChat[String(activeChatId)] = false;
  removeTypingIndicator();

  const ms = await apiCall(`/api/chats/${cid}/messages`);
  const c = document.getElementById('messages-container');

  c.innerHTML = `<div class="flex justify-center my-6"><span class="text-[10px] font-bold tracking-wider text-muted uppercase bg-bar px-3 py-1 rounded-full shadow-sm transition-theme" style="background-color: var(--bar);">Inicio del chat</span></div>`;
  if (ms) ms.forEach(m => {
    const me = m.fromId === currentUser.id;
    appendMessageUI({ id: m.id, text: m.text, time: m.time, from: me ? 'me' : 'them', kind: m.kind, duration: m.duration, peaks: m.peaks, reactions: m.reactions, replyTo: m.replyTo }, false);
  });

  document.getElementById('view-chat').style.transform = 'translateX(0)';
  scrollToBottom();
  updateChatHeaderPresence();

  toggleSendButton();
}

function closeChat() {
  document.getElementById('view-chat').style.transform = 'translateX(100%)';
  removeTypingIndicator();
  activeChatId = null;
  activeChatUserId = null;
  cancelReplyMode();
  stopAnyVoiceRecording(false);
  loadChats();
}

function handleIncomingMessage(d) {
  loadChats();
  if (activeChatId === d.chatId) {
    const m = d.message;
    const me = m.fromId === currentUser.id;

    typingByChat[String(activeChatId)] = false;
    removeTypingIndicator();
    updateChatHeaderPresence();

    appendMessageUI({ id: m.id, text: m.text, time: m.time, from: me ? 'me' : 'them', kind: m.kind, duration: m.duration, peaks: m.peaks, reactions: m.reactions, replyTo: m.replyTo }, true);
  }
}

// =========================
// SEND BUTTON HANDLER
// =========================
function handleSendButton() {
  const input = document.getElementById('message-input');
  const text = (input?.value || '').trim();

  if (pendingImage) { sendMessage(); return; }
  if (text.length > 0) { sendMessage(); return; }

  // no text => mic
  if (isRecording) return;
  startVoiceRecording();
}

function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();

  if (pendingImage) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
         console.warn("WS disconnected, reconnecting...");
         connectWS();
         setTimeout(() => { if (ws && ws.readyState === WebSocket.OPEN) sendImagePayload(pendingImage); }, 400);
      } else {
         sendImagePayload(pendingImage);
      }
      return;
  }

  if (!text || !activeChatId) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("WS disconnected, reconnecting...");
    connectWS();
    setTimeout(sendMessage, 350);
    return;
  }

  sendTyping(false);

  const payload = { type: 'send_message', chatId: activeChatId, text };
  if (replyingToMessage) {
      payload.replyTo = { id: replyingToMessage.id };
      cancelReplyMode();
  }

  ws.send(JSON.stringify(payload));
  input.value = '';
  input.style.height = 'auto';
  toggleSendButton();
}

function sendImagePayload(base64) {
    sendTyping(false);
    const payload = { type: 'send_message', chatId: activeChatId, text: base64 };
    if (replyingToMessage) {
        payload.replyTo = { id: replyingToMessage.id };
        cancelReplyMode();
    }
    ws.send(JSON.stringify(payload));
    cancelImagePreview();
}

// === IMÁGENES ===
function openImagePicker() {
  if (!activeChatId || isRecording) return;
  document.getElementById('chat-image-input').click();
}

async function handleChatImage(input) {
  if (!input.files || !input.files[0] || !activeChatId || isRecording) return;
  const file = input.files[0];
  const dataUrl = await fileToCompressedDataUrl(file, 900, 0.75);

  pendingImage = dataUrl;
  showImagePreview(dataUrl);
  toggleSendButton();

  input.value = '';
}

function showImagePreview(base64) {
    document.getElementById('voice-recorder').classList.add('hidden');
    document.getElementById('text-input-container').classList.add('hidden');

    const preview = document.getElementById('image-preview');
    preview.classList.remove('hidden');
    preview.classList.add('flex');
    document.getElementById('preview-thumb').src = base64;

    refreshIcons();
}

function cancelImagePreview() {
    pendingImage = null;
    document.getElementById('text-input-container').classList.remove('hidden');
    const preview = document.getElementById('image-preview');
    preview.classList.add('hidden');
    preview.classList.remove('flex');
    toggleSendButton();
}

function fileToCompressedDataUrl(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("FileReader error"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image decode error"));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.drawImage(img, 0, 0, w, h);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// =========================
// VOICE: RECORD + SEND
// =========================
function showVoiceUI() {
  const plusBtn = document.getElementById('plus-btn');
  const sendBtn = document.getElementById('send-btn');
  const textBox = document.getElementById('text-input-container');
  const imgPrev = document.getElementById('image-preview');
  const voice = document.getElementById('voice-recorder');

  if (imgPrev && !imgPrev.classList.contains('hidden')) cancelImagePreview();

  if (plusBtn) plusBtn.classList.add('hidden');
  if (sendBtn) sendBtn.classList.add('hidden');
  if (textBox) textBox.classList.add('hidden');

  if (voice) { voice.classList.remove('hidden'); voice.classList.add('flex'); }
  const t = document.getElementById('rec-timer'); if (t) t.textContent = '0:00';
  refreshIcons();
}

function hideVoiceUI() {
  const plusBtn = document.getElementById('plus-btn');
  const sendBtn = document.getElementById('send-btn');
  const textBox = document.getElementById('text-input-container');
  const voice = document.getElementById('voice-recorder');

  if (voice) { voice.classList.add('hidden'); voice.classList.remove('flex'); }
  if (plusBtn) plusBtn.classList.remove('hidden');
  if (sendBtn) sendBtn.classList.remove('hidden');
  if (textBox) textBox.classList.remove('hidden');

  toggleSendButton();
  refreshIcons();
}

function formatMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function pickAudioMimeType() {
  const types = [
    'audio/webm;codecs=opus','audio/webm',
    'audio/ogg;codecs=opus','audio/ogg',
    'audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/aac'
  ];
  for (const t of types) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startVoiceRecording() {
  if (!activeChatId || isRecording) return;

  cancelReplyMode();

  recCanceled = false;
  recMode = null;
  recChunks = [];
  recPCMChunks = [];
  recPeaksRaw = [];

  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
  } catch (e) {
    const msg = (!window.isSecureContext)
      ? 'El micrófono requiere HTTPS (o localhost). Abre wow desde https o desde localhost.'
      : 'Permiso de micrófono denegado';
    showToast(msg, 'error');
    return;
  }

  isRecording = true;
  recStartedAt = Date.now();
  showVoiceUI();

  const timerEl = document.getElementById('rec-timer');
  if (recTick) { clearInterval(recTick); recTick = null; }
  const hardLimitSec = 120;
  recTick = setInterval(() => {
    if (!isRecording) return;
    const sec = (Date.now() - recStartedAt) / 1000;
    if (timerEl) timerEl.textContent = formatMMSS(sec);
    if (sec >= hardLimitSec) finishVoiceRecording();
  }, 250);

  // MediaRecorder (si existe y soporta algo razonable)
  if (typeof MediaRecorder !== 'undefined') {
    const mimeType = pickAudioMimeType();
    try {
      recRecorder = new MediaRecorder(recStream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000
      });
      recMode = 'mediarecorder';
    } catch {
      recRecorder = null;
      recMode = null;
    }
  }

  if (recMode === 'mediarecorder' && recRecorder) {
    startPeaksCaptureMR(recStream);

    recRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
    };

    recRecorder.onstop = async () => {
      // ⚠️ NO tocamos recRecorder antes de aquí (este era el bug)
      try {
        const mime = (recRecorder && recRecorder.mimeType) ? recRecorder.mimeType : (pickAudioMimeType() || 'audio/webm');
        const blob = new Blob(recChunks, { type: mime });
        const durationSec = (Date.now() - recStartedAt) / 1000;
        const peaks = compressPeaks(recPeaksRaw, 64);
        const canceled = recCanceled;

        cleanupVoiceRecording();

        if (canceled || blob.size < 800) return;
        const base64 = await blobToDataUrl(blob);
        await sendVoicePayload(base64, Math.round(durationSec), peaks);
      } catch (e) {
        console.warn('Voice finalize (MR) error', e);
        cleanupVoiceRecording();
      }
    };

    try { recRecorder.start(200); }
    catch (e) {
      console.warn('MediaRecorder.start failed, fallback to WebAudio', e);
      try { if (recRecorder && recRecorder.state !== 'inactive') recRecorder.stop(); } catch {}
      recRecorder = null;
      recMode = null;
      await setupWebAudioFallback();
    }
    return;
  }

  // Fallback Safari/iOS
  await setupWebAudioFallback();
}

function cancelVoiceRecording() {
  if (!isRecording) return;
  showToast('Audio cancelado', 'normal');
  stopAnyVoiceRecording(true);
  hideVoiceUI();
}

function finishVoiceRecording() {
  if (!isRecording) return;
  stopAnyVoiceRecording(false);
  hideVoiceUI();
}

function stopAnyVoiceRecording(isCancel=false) {
  if (!isRecording && !recMode) return;

  recCanceled = !!isCancel;
  isRecording = false;
  if (recTick) { clearInterval(recTick); recTick = null; }

  if (recMode === 'mediarecorder') {
    try { if (recRecorder && recRecorder.state !== 'inactive') recRecorder.stop(); }
    catch (e) { console.warn('MR stop error', e); cleanupVoiceRecording(); }
    return;
  }

  if (recMode === 'webaudio') {
    finalizeWebAudioRecording();
    return;
  }

  cleanupVoiceRecording();
}

async function sendVoicePayload(base64, duration, peaks) {
  if (!activeChatId) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendTyping(false);
    ws.send(JSON.stringify({ type:'send_message', chatId: activeChatId, text: base64, kind:'audio', duration, peaks }));
  } else {
    showToast('Sin conexión, reintentando...', 'error');
    connectWS();
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN && activeChatId) {
        ws.send(JSON.stringify({ type:'send_message', chatId: activeChatId, text: base64, kind:'audio', duration, peaks }));
      }
    }, 450);
  }
}

function startPeaksCaptureMR(stream) {
  try {
    if (recAudioCtx) { try { recAudioCtx.close(); } catch {} recAudioCtx = null; }
    recAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const src = recAudioCtx.createMediaStreamSource(stream);

    recAnalyser = recAudioCtx.createAnalyser();
    recAnalyser.fftSize = 2048;
    recAnalyserData = new Uint8Array(recAnalyser.fftSize);
    src.connect(recAnalyser);

    let lastPush = 0;
    const stepMs = 80;

    const loop = (t) => {
      if (!isRecording || !recAnalyser || !recAnalyserData) return;
      recAnalyser.getByteTimeDomainData(recAnalyserData);

      let sum = 0;
      for (let i = 0; i < recAnalyserData.length; i++) {
        const v = (recAnalyserData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / recAnalyserData.length);

      if (t - lastPush > stepMs) { recPeaksRaw.push(rms); lastPush = t; }
      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  } catch {
    recAnalyser = null;
    recAnalyserData = null;
  }
}

function compressPeaks(peaks, bars=64) {
  if (!peaks || peaks.length === 0) return [];
  const out = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * peaks.length / bars);
    const end = Math.floor((i + 1) * peaks.length / bars);
    let max = 0;
    for (let j = start; j < end; j++) max = Math.max(max, peaks[j] || 0);
    out.push(Math.max(0, Math.min(1000, Math.round(max * 1000))));
  }
  return out;
}

async function setupWebAudioFallback() {
  recMode = 'webaudio';
  try {
    recAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (recAudioCtx.state === 'suspended') { try { await recAudioCtx.resume(); } catch {} }

    recInputSampleRate = recAudioCtx.sampleRate || 48000;
    recSource = recAudioCtx.createMediaStreamSource(recStream);

    recProcessor = recAudioCtx.createScriptProcessor(4096, 1, 1);

    // Para iOS: conectar a destination con ganancia 0 para que procese
    recGain = recAudioCtx.createGain();
    recGain.gain.value = 0;

    recProcessor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      if (!isRecording) return;

      recPCMChunks.push(new Float32Array(input));

      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      recPeaksRaw.push(Math.sqrt(sum / input.length));
    };

    recSource.connect(recProcessor);
    recProcessor.connect(recGain);
    recGain.connect(recAudioCtx.destination);
  } catch (e) {
    console.warn('WebAudio fallback init error', e);
    showToast('Tu navegador no soporta grabación de audio', 'error');
    cleanupVoiceRecording();
  }
}

async function finalizeWebAudioRecording() {
  try {
    try { if (recProcessor) recProcessor.disconnect(); } catch {}
    try { if (recSource) recSource.disconnect(); } catch {}
    try { if (recGain) recGain.disconnect(); } catch {}

    const durationSec = (Date.now() - recStartedAt) / 1000;
    const peaks = compressPeaks(recPeaksRaw, 64);
    const canceled = recCanceled;

    const merged = mergeFloat32(recPCMChunks);
    const targetRate = 16000;
    const pcm = downsampleBuffer(merged, recInputSampleRate, targetRate);
    const wavView = encodeWAV(pcm, targetRate);
    const blob = new Blob([wavView], { type: 'audio/wav' });

    cleanupVoiceRecording();

    if (canceled || blob.size < 1200) return;
    const base64 = await blobToDataUrl(blob);
    await sendVoicePayload(base64, Math.round(durationSec), peaks);
  } catch (e) {
    console.warn('WebAudio finalize error', e);
    cleanupVoiceRecording();
  }
}

function mergeFloat32(chunks) {
  if (!chunks || !chunks.length) return new Float32Array(0);
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function downsampleBuffer(buffer, inRate, outRate) {
  if (!buffer || buffer.length === 0) return new Float32Array(0);
  if (!inRate || !outRate || outRate >= inRate) return buffer;

  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLen);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let acc = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      acc += buffer[i]; count++;
    }
    result[offsetResult] = count ? (acc / count) : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  floatTo16BitPCM(view, 44, samples);
  return view;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function floatTo16BitPCM(view, offset, input) {
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset + i * 2, s, true);
  }
}

function cleanupVoiceRecording() {
  if (recStream) { try { recStream.getTracks().forEach(t => t.stop()); } catch {} }
  recStream = null;

  recRecorder = null;
  recChunks = [];

  recSource = null;
  recProcessor = null;
  recGain = null;
  recPCMChunks = [];

  recAnalyser = null;
  recAnalyserData = null;
  recPeaksRaw = [];

  if (recAudioCtx) { try { recAudioCtx.close(); } catch {} }
  recAudioCtx = null;

  recMode = null;
  recCanceled = false;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('FileReader'));
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

// =========================
// REACTIONS (double click)
// =========================
function toggleHeart(messageId) {
  if (!activeChatId || !messageId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    setTimeout(() => toggleHeart(messageId), 350);
    return;
  }

  ws.send(JSON.stringify({
    type: 'react_message',
    chatId: activeChatId,
    messageId: messageId,
    reaction: 'heart'
  }));
}

function handleReactionUpdate(data) {
  const mid = data.messageId;
  const reactions = data.reactions || {};
  if (!mid) return;
  reactionsByMessageId[String(mid)] = reactions;

  if (activeChatId && String(data.chatId) === String(activeChatId)) {
    updateHeartUI(mid, reactions, data.active === true);
  }
}

function updateHeartUI(messageId, reactions, animate=false) {
  const mid = String(messageId);
  const wrap = document.getElementById(`msg-${mid}`);
  if (!wrap) return;
  const heart = wrap.querySelector('.heart-reaction');
  if (!heart) return;

  const heartList = (reactions && reactions.heart) ? reactions.heart : [];
  const isOn = heartList.map(String).includes(String(currentUser.id));

  if (isOn) {
    heart.classList.add('show');
    if (animate) {
      heart.classList.remove('beat');
      void heart.offsetWidth;
      heart.classList.add('beat');
      setTimeout(() => heart.classList.remove('beat'), 520);
    }
  } else {
    heart.classList.remove('show');
  }

  refreshIcons();
}

// =========================
// UI: APPEND MESSAGE + SWIPE TO REPLY
// =========================
function appendMessageUI(m, ani=false) {
  const c = document.getElementById('messages-container'); if (!c) return;
  removeTypingIndicator();

  const me = m.from === 'me';
  const msgId = m.id != null ? String(m.id) : String(Date.now());

  if (m.reactions) reactionsByMessageId[msgId] = m.reactions;

  const d = document.createElement('div');
  d.id = `msg-${msgId}`;
  d.className = `flex ${me ? 'justify-end' : 'justify-start'} mb-2 group`;
  if (ani) d.classList.add('animate-slide-up-subtle');

  let content = `<span class="msg-text">${escapeHtml(m.text)}</span>`;
  let bubbleClass = me ? 'bubble-me' : 'bubble-them';

  const isImage = (typeof m.text === 'string' && m.text.startsWith('data:image'));
  const isAudio = (m.kind === 'audio') || (typeof m.text === 'string' && m.text.startsWith('data:audio'));

  // Quote HTML
  let quoteHtml = '';
  if (m.replyTo) {
      const rText = (m.replyTo.kind === 'image' || (m.replyTo.text && m.replyTo.text.startsWith('data:image'))) ? '📷 Foto'
                  : (m.replyTo.kind === 'audio' || (m.replyTo.text && m.replyTo.text.startsWith('data:audio'))) ? '🎤 Nota de voz'
                  : escapeHtml(m.replyTo.text || '');
      const rName = (m.replyTo.fromId === currentUser.id) ? 'Tú' : document.getElementById('chat-header-name').innerText;

      quoteHtml = `
        <div class="reply-context" onclick="scrollToMessage('${m.replyTo.id}')">
            <span class="reply-context-name">${rName}</span>
            <span class="reply-context-text">${rText}</span>
        </div>
      `;
  }

  if (isImage) {
    content = `${quoteHtml}<img src="${m.text}" class="msg-image" alt="imagen">`;
    bubbleClass += ' msg-bubble-image';
  } else if (isAudio) {
    bubbleClass += ' msg-bubble voice-bubble';
    content = `${quoteHtml}` + renderVoiceMessageHTML(msgId, m.text, m.peaks || [], (typeof m.duration === 'number' ? m.duration : null));
  } else {
    bubbleClass += ' msg-bubble';
    content = `${quoteHtml}<span class="msg-text">${escapeHtml(m.text)}</span>`;
  }

  const myHeartOn = (reactionsByMessageId[msgId]?.heart || []).map(String).includes(String(currentUser.id));

  d.innerHTML = `
    <div class="relative max-w-[78%] ${bubbleClass} shadow-sm transition-theme" ondblclick="toggleHeart('${msgId}')">
      ${content}
      <span class="msg-meta">
        <span>${escapeHtml(m.time || '')}</span>
        ${me ? '<i data-lucide="check-check" class="w-3 h-3"></i>' : ''}
      </span>
      <div class="heart-reaction ${myHeartOn ? 'show' : ''}">
        <i data-lucide="heart" class="w-4 h-4" style="color:#ef4444; fill:#ef4444"></i>
      </div>
    </div>`;

  c.appendChild(d);

  // Add Swipe listeners
  const bubble = d.querySelector(`.${me ? 'bubble-me' : 'bubble-them'}`);
  addSwipeListeners(bubble, msgId, isImage ? '📷 Foto' : (isAudio ? '🎤 Nota de voz' : m.text), me);

  refreshIcons();
  scrollToBottom();

  if (isAudio) initVoiceMessage(msgId, m.text, m.peaks || [], (typeof m.duration==='number'?m.duration:null), me);
}

function addSwipeListeners(el, id, text, isMe) {
    let touchStartX = 0;
    let touchStartY = 0;
    let currentX = 0;

    el.addEventListener('touchstart', e => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        el.style.transition = 'none';
    }, {passive: true});

    el.addEventListener('touchmove', e => {
        currentX = e.touches[0].clientX;
        const diffX = currentX - touchStartX;
        const diffY = e.touches[0].clientY - touchStartY;

        // Ignorar scroll vertical
        if (Math.abs(diffY) > Math.abs(diffX)) return;

        // Limitar dirección según si es mío o del otro
        if (isMe && diffX > 0) return; // Mío: solo izquierda
        if (!isMe && diffX < 0) return; // Suyo: solo derecha

        // Resistencia visual
        const translateX = diffX * 0.4;
        if (Math.abs(translateX) < 60) {
             el.style.transform = `translateX(${translateX}px)`;
        }
    }, {passive: true});

    el.addEventListener('touchend', e => {
        el.style.transition = 'transform 0.2s ease';
        el.style.transform = 'translateX(0)';

        const diffX = currentX - touchStartX;
        // Threshold para activar
        if (Math.abs(diffX) > 50) {
             // Validar dirección de nuevo
             if ((isMe && diffX < 0) || (!isMe && diffX > 0)) {
                  setReplyMode({ id, text, name: isMe ? 'Tú' : document.getElementById('chat-header-name').innerText });
             }
        }
    });
}

function setReplyMode(msg) {
    replyingToMessage = msg;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('reply-preview-name').innerText = msg.name;
    document.getElementById('reply-preview-text').innerText = msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '');
    document.getElementById('message-input').focus();
}

function cancelReplyMode() {
    replyingToMessage = null;
    document.getElementById('reply-preview').classList.add('hidden');
}

function scrollToMessage(id) {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('bg-wow-500/10');
        setTimeout(() => el.classList.remove('bg-wow-500/10'), 1000);
    }
}

function renderVoiceMessageHTML(msgId, dataUrl, peaks, durationSec) {
  const durText = (typeof durationSec === 'number') ? formatMMSS(durationSec) : '--:--';
  return `
    <div class="voice-row">
      <button class="voice-play" onclick="togglePlayAudio('${msgId}'); event.stopPropagation();">
        <i id="audio-icon-${msgId}" data-lucide="play" class="w-4 h-4"></i>
      </button>
      <canvas id="wave-${msgId}" class="voice-wave" width="340" height="48"></canvas>
      <span id="audio-time-${msgId}" class="voice-time">${durText}</span>
    </div>
  `;
}

function initVoiceMessage(msgId, dataUrl, peaks, durationSec, isMeBubble) {
  const canvas = document.getElementById(`wave-${msgId}`);
  const timeEl = document.getElementById(`audio-time-${msgId}`);
  if (!canvas || !timeEl) return;

  let p = Array.isArray(peaks) && peaks.length ? peaks : Array.from({length:64}, (_,i)=>{
    const v = Math.abs(Math.sin((i/64)*Math.PI*3));
    return Math.round(180 + v*620);
  });

  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = dataUrl;

  audio.addEventListener('loadedmetadata', () => {
    const dur = isFinite(audio.duration) ? audio.duration : durationSec;
    if (dur && timeEl) timeEl.textContent = formatMMSS(dur);
  });

  audio.addEventListener('ended', () => {
    setAudioPlaying(msgId, false);
    drawWaveform(canvas, p, 0, isMeBubble);
  });

  audioPlayers[msgId] = { audio, peaks: p, canvas, timeEl, playing:false, raf:null, isMe:isMeBubble };
  drawWaveform(canvas, p, 0, isMeBubble);
}

function togglePlayAudio(msgId) {
  const item = audioPlayers[msgId];
  if (!item) return;

  Object.keys(audioPlayers).forEach(k => {
    if (k !== msgId) {
      const it = audioPlayers[k];
      if (it?.playing) {
        try { it.audio.pause(); } catch {}
        setAudioPlaying(k, false);
      }
    }
  });

  if (item.playing) {
    try { item.audio.pause(); } catch {}
    setAudioPlaying(msgId, false);
  } else {
    try { item.audio.play(); } catch {}
    setAudioPlaying(msgId, true);
    startAudioProgressLoop(msgId);
  }

  refreshIcons();
}

function setAudioPlaying(msgId, isOn) {
  const item = audioPlayers[msgId];
  if (!item) return;
  item.playing = !!isOn;

  const icon = document.getElementById(`audio-icon-${msgId}`);
  if (icon) icon.setAttribute('data-lucide', item.playing ? 'pause' : 'play');

  if (!item.playing) {
    if (item.raf) { cancelAnimationFrame(item.raf); item.raf = null; }
  }
  refreshIcons();
}

function startAudioProgressLoop(msgId) {
  const item = audioPlayers[msgId];
  if (!item) return;

  const tick = () => {
    if (!item.playing) return;
    const a = item.audio;
    const dur = a.duration || 0;
    const prog = dur > 0 ? (a.currentTime / dur) : 0;

    drawWaveform(item.canvas, item.peaks, prog, item.isMe);
    if (item.timeEl && dur > 0) {
      const remain = Math.max(0, dur - a.currentTime);
      item.timeEl.textContent = formatMMSS(remain);
    }

    item.raf = requestAnimationFrame(tick);
  };
  item.raf = requestAnimationFrame(tick);
}

function drawWaveform(canvas, peaks, progress=0, isMeBubble=false) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);

  const bars = peaks.length;
  const pad = 6;
  const usableW = w - pad*2;
  const barW = usableW / bars;

  for (let i = 0; i < bars; i++) {
    const v = (peaks[i] || 0) / 1000;
    const barH = Math.max(3, v * (h - 10));
    const x = pad + i * barW;
    const y = (h - barH) / 2;

    const played = (i / bars) <= progress;
    let col;
    if (isMeBubble) col = played ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
    else col = played ? 'rgba(2,132,199,0.9)' : 'rgba(15,23,42,0.25)';

    ctx.fillStyle = col;
    const bw = Math.max(1, barW * 0.55);
    ctx.fillRect(x, y, bw, barH);
  }
}

function scrollToBottom() {
  const c = document.getElementById('messages-container');
  if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
}

function toggleDarkModeUI() { currentUser.darkMode = !currentUser.darkMode; applyTheme(); updateToggleUI(); persistSettings(); }
function setTheme(t) { currentUser.theme = t; applyTheme(); persistSettings(); }

async function persistSettings() {
  const p = { username: currentUser.username, name: currentUser.name, bio: currentUser.bio, avatarSeed: currentUser.avatarSeed, theme: currentUser.theme, darkMode: currentUser.darkMode };
  await apiCall('/api/me/profile', 'POST', p);
}

function openSettings() {
  document.getElementById('view-settings').classList.remove('hidden');
  setTimeout(() => {
    document.getElementById('view-settings').classList.remove('opacity-0');
    document.getElementById('settings-panel').classList.remove('translate-y-full');
  }, 10);
}

function closeSettings() {
  document.getElementById('view-settings').classList.add('opacity-0');
  document.getElementById('settings-panel').classList.add('translate-y-full');
  setTimeout(() => document.getElementById('view-settings').classList.add('hidden'), 500);
}

function openChangePassword() {
  document.getElementById('view-change-password').classList.remove('hidden');
  document.getElementById('cp-step-1').classList.remove('hidden');
  document.getElementById('cp-step-2').classList.add('hidden');
  document.getElementById('cp-success').classList.add('hidden');
  document.getElementById('current-pass-input').value = "";
  document.getElementById('new-pass-input').value = "";
  document.getElementById('cp-error-1').innerText = "";
}

function closeChangePassword() { document.getElementById('view-change-password').classList.add('hidden'); }

async function verifyCurrentPassword() {
  const p = document.getElementById('current-pass-input').value;
  if (!p) return;
  const r = await fetch(getBaseUrl('/auth/login'), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ username: currentUser.username, password: p }) });
  if (r.ok) {
    document.getElementById('cp-step-1').classList.add('hidden');
    const s2 = document.getElementById('cp-step-2');
    s2.classList.remove('hidden','opacity-0','translate-x-10');
  } else {
    document.getElementById('cp-error-1').innerText = "Contraseña incorrecta";
  }
}

async function doChangePassword() {
  const c = document.getElementById('current-pass-input').value;
  const n = document.getElementById('new-pass-input').value;
  if (!n) return;
  const r = await fetch(getBaseUrl('/auth/change-password'), { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include', body: JSON.stringify({ current_password: c, new_password: n }) });
  if (r.ok) {
    document.getElementById('cp-step-2').classList.add('hidden');
    document.getElementById('cp-success').classList.remove('hidden');
    refreshIcons();
    setTimeout(() => { closeChangePassword(); closeSettings(); }, 1500);
  }
}

function switchTab(t) {
  document.querySelectorAll('.tab-view').forEach(e => e.classList.remove('tab-active'));
  const tg = document.getElementById(`tab-${t}`);
  if (tg) {
    tg.classList.add('tab-active');
    if (t === 'people') loadPeople();
    if (t === 'chats') loadChats();
    if (t === 'admin') loadAdminData();
    if (t === 'stories') loadStories();
  }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const ab = document.querySelector(`.nav-btn[data-target="${t}"]`);
  if (ab) ab.classList.add('active');
}

function closeEditProfile() { document.getElementById('view-edit-profile').classList.add('hidden'); }
function editProfile() { document.getElementById('view-edit-profile').classList.remove('hidden'); }

async function saveProfile() {
  const currentSrc = document.getElementById('edit-avatar-img').src;
  let newSeed = currentUser.avatarSeed;
  if (currentSrc.startsWith('data:')) newSeed = currentSrc;

  const p = {
    username: document.getElementById('edit-username-input').value,
    name: document.getElementById('edit-name-input').value,
    bio: document.getElementById('edit-bio-input').value,
    avatarSeed: newSeed,
    theme: currentUser.theme,
    darkMode: currentUser.darkMode
  };
  const u = await apiCall('/api/me/profile','POST',p);
  if (u) { currentUser = u; updateProfileUI(); closeEditProfile(); }
}

// --- CROPPER ---
function changeAvatar() { document.getElementById('avatar-upload').click(); }

function handleAvatarFile(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      cropperImg = new Image();
      cropperImg.onload = function() { initCropper(); };
      cropperImg.src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
  }
}

function initCropper() {
  document.getElementById('view-crop-avatar').classList.remove('hidden');
  cropperCanvas = document.getElementById('crop-canvas');
  cropperCtx = cropperCanvas.getContext('2d');
  const size = Math.min(window.innerWidth - 40, 320);
  cropperCanvas.width = size;
  cropperCanvas.height = size;

  const scaleX = size / cropperImg.width;
  const scaleY = size / cropperImg.height;
  cropScale = Math.max(scaleX, scaleY);

  cropperZoom = 1;
  cropPos.x = (size - cropperImg.width * cropScale) / 2;
  cropPos.y = (size - cropperImg.height * cropScale) / 2;
  drawCropper();
}

function drawCropper() {
  if (!cropperCtx) return;
  const size = cropperCanvas.width;
  cropperCtx.clearRect(0,0,size,size);
  const drawScale = cropScale * cropperZoom;
  cropperCtx.drawImage(cropperImg, cropPos.x, cropPos.y, cropperImg.width * drawScale, cropperImg.height * drawScale);
}

function onWheel(e) {
  e.preventDefault();
  const zoomSpeed = 0.001;
  let newZoom = cropperZoom + e.deltaY * -zoomSpeed;
  cropperZoom = Math.min(Math.max(1, newZoom), 3);
  drawCropper();
}

function handleTouchStart(e) {
    if (e.touches.length === 2) {
        isDraggingCrop = false;
        initialPinchDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
        initialScale = cropperZoom;
    } else if (e.touches.length === 1) {
        startDrag(e.touches[0]);
    }
}

function handleTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
        const scaleFactor = dist / initialPinchDist;
        cropperZoom = Math.min(Math.max(1, initialScale * scaleFactor), 3);
        drawCropper();
    } else if (e.touches.length === 1) {
        onDrag(e.touches[0]);
    }
}

function startDrag(e) { isDraggingCrop = true; dragStart.x = e.clientX || e.pageX; dragStart.y = e.clientY || e.pageY; }
function onDrag(e) {
  if (!isDraggingCrop) return;
  const x = e.clientX || e.pageX;
  const y = e.clientY || e.pageY;
  cropPos.x += (x - dragStart.x);
  cropPos.y += (y - dragStart.y);
  dragStart.x = x;
  dragStart.y = y;
  drawCropper();
}
function endDrag() { isDraggingCrop = false; }
function closeCropAvatar() { document.getElementById('view-crop-avatar').classList.add('hidden'); }

function saveCroppedAvatar() {
  const outCanvas = document.createElement('canvas');
  outCanvas.width = 256;
  outCanvas.height = 256;
  const ctx = outCanvas.getContext('2d');

  const visualSize = cropperCanvas.width;
  const ratio = 256 / visualSize;
  const drawScale = cropScale * cropperZoom * ratio;

  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2, true);
  ctx.closePath();
  ctx.clip();

  ctx.drawImage(cropperImg, cropPos.x * ratio, cropPos.y * ratio, cropperImg.width * drawScale, cropperImg.height * drawScale);

  const base64 = outCanvas.toDataURL('image/jpeg', 0.8);
  document.getElementById('edit-avatar-img').src = base64;
  closeCropAvatar();
}

// --- STORIES LOGIC ---
function openCreateStory() {
    document.getElementById('view-story-create').classList.remove('hidden');
    document.getElementById('story-upload-zone').classList.remove('hidden');
    document.getElementById('story-upload-zone').classList.add('flex');
    document.getElementById('story-preview-zone').classList.add('hidden');
    document.getElementById('story-actions').classList.add('hidden');
    document.getElementById('story-file-input').value = '';
    pendingStoryImg = null;
}

function closeCreateStory() {
    document.getElementById('view-story-create').classList.add('hidden');
}

async function handleStoryFile(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];
    const dataUrl = await fileToCompressedDataUrl(file, 1080, 0.8);

    pendingStoryImg = dataUrl;
    document.getElementById('story-preview-img').src = dataUrl;

    document.getElementById('story-upload-zone').classList.add('hidden');
    document.getElementById('story-upload-zone').classList.remove('flex');

    document.getElementById('story-preview-zone').classList.remove('hidden');
    document.getElementById('story-actions').classList.remove('hidden');
}

async function uploadStory() {
    if (!pendingStoryImg) return;
    const caption = document.getElementById('story-caption').value.trim();

    const res = await apiCall('/api/stories', 'POST', { image: pendingStoryImg, caption });
    if (res) {
        closeCreateStory();
        showToast("Historia subida", "normal");
        loadStories();
    } else {
        showToast("Error al subir historia", "error");
    }
}

function toggleSendButton() {
  const i = document.getElementById('message-input');
  const m = document.getElementById('icon-mic');
  const s = document.getElementById('icon-send');
  if (!i || !m || !s) return;

  if (!document.getElementById('voice-recorder')?.classList.contains('hidden')) return;

  if (i.value.trim().length > 0 || pendingImage) {
    m.classList.add('scale-0','-rotate-90','opacity-0');
    s.classList.remove('scale-0','rotate-90','opacity-0','translate-x-4');
  } else {
    s.classList.add('scale-0','rotate-90','opacity-0','translate-x-4');
    m.classList.remove('scale-0','-rotate-90','opacity-0');
  }
}

// =========================
// TYPING: EMIT + UI
// =========================
function emitTypingSmart() {
  if (!activeChatId || isRecording) return;

  const now = Date.now();
  if (now - lastTypingSentAt > 900) {
    sendTyping(true);
    lastTypingSentAt = now;
  }

  if (typingStopTimer) clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => sendTyping(false), 1200);
}

function sendTyping(isTyping) {
  if (!activeChatId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'typing_status',
    chatId: activeChatId,
    isTyping: !!isTyping
  }));
}

function setRemoteTyping(isTyping) {
  if (!activeChatId) return;
  typingByChat[String(activeChatId)] = !!isTyping;

  if (isTyping) showTypingIndicator();
  else removeTypingIndicator();

  updateChatHeaderPresence();
}

function showTypingIndicator() {
  const c = document.getElementById('messages-container');
  if (!c) return;
  if (document.getElementById('typing-indicator')) return;

  const wrap = document.createElement('div');
  wrap.id = 'typing-indicator';
  wrap.className = 'flex justify-start mb-2';

  wrap.innerHTML = `
    <div class="relative msg-bubble bubble-them shadow-sm transition-theme"
         style="padding:10px 14px 10px 14px; display:flex; align-items:center;">
      <div class="flex items-center gap-1">
        <span class="typing-dot w-2 h-2 rounded-full bg-slate-400 inline-block"></span>
        <span class="typing-dot w-2 h-2 rounded-full bg-slate-400 inline-block"></span>
        <span class="typing-dot w-2 h-2 rounded-full bg-slate-400 inline-block"></span>
      </div>
    </div>
  `;

  c.appendChild(wrap);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}