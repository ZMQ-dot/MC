/**
 * Minecraft 聊天室前端逻辑
 * 使用 WebRTC Mesh 架构实现多人语音聊天
 */

// ========== 全局状态 ==========
let userId = null;
let userNickname = null;
let userAvatar = null;
let currentRoomId = null;
let currentRoomType = null;
let currentInviteType = null;
let socket = null;
let socketEventsInitialized = false;
let isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);

// 语音消息相关
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordStartTime = 0;

// WebRTC 相关
let localStream = null;
let peerConnections = {};  // user_id -> RTCPeerConnection
let isVoiceChatActive = false;
let isMuted = false;
let audioContext = null;
let pendingVoiceInviteRoomId = null;
let pendingVoiceInviteFromUser = null;
let contextRoomId = null;

// WebRTC 配置
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    if (isMobile) {
        console.log('检测到移动设备');
        initMobilePermissions();
    }
    initLogin();
    initSkinUpload();
    loadSavedUser();

    document.addEventListener('dblclick', (e) => {
        e.preventDefault();
    }, { passive: false });
});

// ========== 移动端权限初始化 ==========
async function initMobilePermissions() {
    try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            console.log('请求麦克风权限...');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('麦克风权限已获取');
            stream.getTracks().forEach(track => track.stop());
        }
    } catch (error) {
        console.warn('麦克风权限请求失败:', error);
    }

    document.addEventListener('touchstart', () => {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log('AudioContext 已初始化');
            } catch (e) {
                console.error('AudioContext 创建失败:', e);
            }
        }
    }, { once: true, passive: true });
}

// ========== 登录流程 ==========
function initLogin() {
    const nicknameInput = document.getElementById('nickname-input');
    const nicknameBtn = document.getElementById('nickname-btn');

    nicknameBtn.addEventListener('click', async () => {
        const nickname = nicknameInput.value.trim();
        if (!nickname) {
            alert('请输入昵称!');
            return;
        }

        console.log('尝试登录，昵称:', nickname);

        try {
            const formData = new FormData();
            formData.append('nickname', nickname);

            const response = await fetch('/login', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP 错误：${response.status}`);
            }

            const data = await response.json();
            console.log('登录响应数据:', data);

            if (data.success) {
                userId = data.user_id;
                userNickname = data.nickname;
                saveUser(nickname);
                document.getElementById('step-nickname').classList.add('hidden');
                document.getElementById('step-skin').classList.remove('hidden');
            } else {
                alert(data.message || '登录失败');
            }
        } catch (error) {
            console.error('登录失败:', error);
            alert('登录失败：' + error.message + '。请确保服务器正在运行。');
        }
    });

    nicknameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') nicknameBtn.click();
    });
}

// ========== 皮肤上传 ==========
function initSkinUpload() {
    const skinUpload = document.getElementById('skin-upload');
    const enterBtn = document.getElementById('enter-btn');

    skinUpload.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const validTypes = ['image/png', 'image/x-png'];
        if (!validTypes.includes(file.type)) {
            const fileName = file.name.toLowerCase();
            if (!fileName.endsWith('.png')) {
                alert('请选择 PNG 格式的皮肤文件!');
                return;
            }
        }

        if (!userId) {
            alert('请先输入昵称完成登录!');
            return;
        }

        const formData = new FormData();
        formData.append('user_id', userId);
        formData.append('skin', file);

        enterBtn.textContent = '上传中...';
        enterBtn.disabled = true;

        try {
            const response = await fetch('/upload_skin', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();
            if (data.success) {
                userAvatar = data.avatar;
                saveAvatar(data.avatar);

                const model = document.getElementById('skin-model');
                if (model) {
                    model.style.backgroundImage = `url(${data.skin_url}?t=${Date.now()})`;
                    model.style.backgroundSize = '64px 64px';
                }

                enterBtn.disabled = false;
                enterBtn.textContent = '进入聊天室';
                console.log('皮肤上传成功');
            } else {
                alert(data.message || '上传失败');
                enterBtn.disabled = false;
                enterBtn.textContent = '进入聊天室';
            }
        } catch (error) {
            console.error('上传失败:', error);
            alert('上传失败：' + error.message);
            enterBtn.disabled = false;
            enterBtn.textContent = '进入聊天室';
        }
    });

    document.getElementById('enter-btn').addEventListener('click', enterChatRoom);
}

// ========== 本地存储功能 ==========
function saveUser(nickname) {
    try {
        const data = { nickname, savedAt: Date.now() };
        localStorage.setItem('mc_chat_user', JSON.stringify(data));
    } catch (e) {
        console.error('保存用户信息失败:', e);
    }
}

function saveAvatar(avatarBase64) {
    try {
        localStorage.setItem('mc_chat_avatar', avatarBase64);
    } catch (e) {
        console.error('保存头像失败:', e);
    }
}

function saveRoom(roomId, roomName, roomType) {
    try {
        let rooms = JSON.parse(localStorage.getItem('mc_chat_rooms') || '[]');
        const exists = rooms.some(r => r.roomId === roomId);
        if (!exists) {
            rooms.push({ roomId, roomName, roomType, savedAt: Date.now() });
            localStorage.setItem('mc_chat_rooms', JSON.stringify(rooms));
        }
    } catch (e) {
        console.error('保存房间失败:', e);
    }
}

function loadSavedRooms() {
    try {
        return JSON.parse(localStorage.getItem('mc_chat_rooms') || '[]');
    } catch (e) {
        console.error('加载房间失败:', e);
        return [];
    }
}

function loadSavedUser() {
    try {
        const savedData = localStorage.getItem('mc_chat_user');
        const savedAvatar = localStorage.getItem('mc_chat_avatar');

        if (savedData) {
            const data = JSON.parse(savedData);
            if (data.nickname) {
                document.getElementById('nickname-input').value = data.nickname;
            }
        }

        if (savedAvatar) {
            userAvatar = savedAvatar;
            const hint = document.querySelector('.hint');
            if (hint) {
                hint.innerHTML = '✓ 已使用上次的头像 <button onclick="clearSavedData()" style="margin-left:10px;padding:2px 8px;cursor:pointer;">清除</button>';
            }
        }
    } catch (e) {
        console.error('加载用户信息失败:', e);
    }
}

function clearSavedData() {
    localStorage.removeItem('mc_chat_user');
    localStorage.removeItem('mc_chat_avatar');
    localStorage.removeItem('mc_chat_rooms');
    location.reload();
}

// ========== 进入聊天室 ==========
async function enterChatRoom() {
    console.log('进入聊天室，userId:', userId);

    socket = io();

    await new Promise((resolve) => {
        if (socket.connected) {
            resolve();
        } else {
            socket.on('connect', () => {
                console.log('✅ Socket 连接成功');
                resolve();
            });
            setTimeout(() => resolve(), 3000);
        }
    });

    initSocketEvents();
    socket.emit('register_user', { user_id: userId });

    document.getElementById('login-page').classList.remove('active');
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('main-page').classList.remove('hidden');
    document.getElementById('main-page').classList.add('active');

    document.getElementById('user-nickname').textContent = userNickname;
    document.getElementById('user-avatar').src = userAvatar || '/static/css/default-avatar.png';
    document.getElementById('welcome-name').textContent = userNickname;

    loadSavedRoomsToUI();

    setTimeout(() => {
        socket.emit('get_rooms', { user_id: userId });
    }, 500);
}

function loadSavedRoomsToUI() {
    const rooms = loadSavedRooms();
    rooms.forEach(room => {
        addRoomToList(room.roomId, room.roomName, room.roomType);
    });
}

// ========== WebSocket 事件 ==========
function initSocketEvents() {
    if (socketEventsInitialized) {
        return;
    }
    socketEventsInitialized = true;
    console.log('初始化 Socket 事件...');

    socket.on('invite_created', (data) => {
        console.log('✅ 邀请创建成功！数据:', data);
        showInviteCode(data.code);
        currentRoomId = data.room_id;
        currentRoomType = data.type;
        addRoomToList(data.room_id, data.room_name, data.type);
        saveRoom(data.room_id, data.room_name, data.type);

        switchToChatView();
        openChat(data.room_id, data.room_name, data.type, [{ user_id: userId, nickname: userNickname, avatar: userAvatar }]);
    });

    socket.on('invite_error', (data) => {
        alert(data.message);
    });

    socket.on('join_success', (data) => {
        console.log('✅ 加入成功！数据:', data);
        closeModal('join-modal');
        saveRoom(data.room_id, data.room_name, data.room_type);

        const roomsContainer = document.getElementById('rooms-container');
        if (roomsContainer && !document.querySelector(`[data-room-id="${data.room_id}"]`)) {
            addRoomToList(data.room_id, data.room_name, data.room_type);
        }

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'pre-fix',
                hypothesisId: 'H1',
                location: 'static/js/app.js:socket.join_success',
                message: 'join_success received',
                data: {
                    roomId: data.room_id,
                    roomName: data.room_name,
                    roomType: data.room_type,
                    memberCount: data.members?.length || 0
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        switchToChatView();
        openChat(data.room_id, data.room_name, data.room_type, data.members);
    });

    socket.on('join_error', (data) => {
        console.log('❌ 加入错误:', data);
        document.getElementById('join-error').textContent = data.message;
        document.getElementById('join-error').classList.remove('hidden');

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'pre-fix',
                hypothesisId: 'H1',
                location: 'static/js/app.js:socket.join_error',
                message: 'join_error received',
                data: {
                    message: data.message
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
    });

    socket.on('new_message', (data) => {
        appendMessage(data);
    });

    socket.on('message_error', (data) => {
        alert(data.message);
    });

    socket.on('user_joined', (data) => {
        if (currentRoomId) {
            appendSystemMessage(`${data.nickname} 加入了聊天`);
        }
    });

    socket.on('user_left', (data) => {
        if (currentRoomId) {
            appendSystemMessage(`${data.nickname} 离开了聊天`);
        }
    });

    socket.on('rooms_list', (data) => {
        console.log('收到房间列表:', data);
        data.rooms.forEach(room => {
            const existingRoom = document.querySelector(`[data-room-id="${room.room_id}"]`);
            if (!existingRoom) {
                addRoomToList(room.room_id, room.name, room.type);
                saveRoom(room.room_id, room.name, room.type);
            }
        });
    });

    // 接收房间成员列表
    socket.on('room_members_list', (data) => {
        console.log('收到房间成员列表:', data);
        if (data.room_id === currentRoomId && currentRoomType === 'group') {
            // 更新在线人数显示
            document.getElementById('chat-members').textContent = `${data.member_count} 人在线`;
            
            // 更新当前房间成员列表，用于语音连接
            window.currentRoomMembers = data.members || [];
        }
    });

    socket.on('room_deleted', (data) => {
        console.log('房间已被删除:', data);

        const { room_id, room_name, initiator_id, initiator_nickname } = data;

        // 如果当前打开的是被删除房间，返回首页并清空聊天
        if (currentRoomId === room_id) {
            currentRoomId = null;
            currentRoomType = null;

            const messages = document.getElementById('messages-container');
            if (messages) messages.innerHTML = '';

            document.getElementById('chat-name').textContent = '';
            document.getElementById('chat-members').textContent = '';

            showView('home');
        }

        removeRoomFromList(room_id);
        removeRoomFromStorage(room_id);

        const tipName = initiator_nickname || '有人';
        alert(`${tipName} 删除了房间「${room_name || ''}」`);
    });

    socket.on('delete_room_error', (data) => {
        if (data && data.message) {
            alert(data.message);
        }
    });

    // ========== WebRTC 信令事件 ==========
    
    // 新用户加入语音房间
    socket.on('user_joined_voice', (data) => {
        console.log('用户加入语音房间:', data);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V1',
                location: 'static/js/app.js:socket.user_joined_voice',
                message: 'user_joined_voice received',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    joinedUserId: data.user_id,
                    existingUserIds: (data.existing_users || []).map(u => u.user_id)
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        // 如果是自己加入，连接到已存在的用户
        if (data.user_id === userId) {
            data.existing_users.forEach(existingUser => {
                createPeerConnection(existingUser.user_id, true);
            });
            // 添加现有用户到语音面板
            data.existing_users.forEach(existingUser => {
                addVoiceParticipant(existingUser.user_id);
            });
            return;
        }

        // 如果语音聊天已激活，自动连接到新用户
        if (isVoiceChatActive && currentRoomId) {
            createPeerConnection(data.user_id, true);
            addVoiceParticipant(data.user_id);
        } else {
            // 其他人发起语音时，给当前用户一个"可加入语音"的通知
            if (currentRoomId) {
                pendingVoiceInviteRoomId = currentRoomId;
                pendingVoiceInviteFromUser = data.nickname || '有人';

                const notif = document.getElementById('voice-notification');
                const text = document.getElementById('voice-notification-text');
                if (notif && text) {
                    text.textContent = `${pendingVoiceInviteFromUser} 发起了语音聊天，点击加入`;
                    notif.classList.remove('hidden');
                }
            }
        }
    });

    // 语音房间用户列表
    socket.on('voice_room_users', (data) => {
        console.log('语音房间用户列表:', data);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V1',
                location: 'static/js.app.js:socket.voice_room_users',
                message: 'voice_room_users received',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    userIds: (data.users || []).map(u => u.user_id)
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        data.users.forEach(user => {
            createPeerConnection(user.user_id, true);
        });
    });

    // 用户离开语音房间
    socket.on('user_left_voice', (data) => {
        console.log('用户离开语音房间:', data);
        if (peerConnections[data.user_id]) {
            peerConnections[data.user_id].close();
            delete peerConnections[data.user_id];
        }
        removeVoiceParticipant(data.user_id);
    });

    // 接收 WebRTC Offer
    socket.on('webrtc_offer', async (data) => {
        console.log('收到 Offer 来自:', data.from_user_id);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V2',
                location: 'static/js/app.js:socket.webrtc_offer',
                message: 'webrtc_offer received',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    fromUserId: data.from_user_id
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
        try {
            const peerId = getPeerId(data.from_user_id, userId);
            
            let peerConnection = peerConnections[peerId];
            if (!peerConnection) {
                peerConnection = createPeerConnection(data.from_user_id, false);
            }
            
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit('webrtc_answer', {
                room_id: currentRoomId,
                target_user_id: data.from_user_id,
                answer: peerConnection.localDescription,
                from_user_id: userId
            });
        } catch (error) {
            console.error('处理 Offer 失败:', error);
        }
    });

    // 接收 WebRTC Answer
    socket.on('webrtc_answer', async (data) => {
        console.log('收到 Answer 来自:', data.from_user_id);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V2',
                location: 'static/js/app.js:socket.webrtc_answer',
                message: 'webrtc_answer received',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    fromUserId: data.from_user_id
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
        try {
            const peerId = getPeerId(data.from_user_id, userId);
            const peerConnection = peerConnections[peerId];
            
            if (peerConnection) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        } catch (error) {
            console.error('处理 Answer 失败:', error);
        }
    });

    // 接收 ICE 候选
    socket.on('webrtc_ice_candidate', async (data) => {
        try {
            const peerId = getPeerId(data.from_user_id, userId);
            const peerConnection = peerConnections[peerId];
            
            if (peerConnection && data.candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));

                // #region agent log
                fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Debug-Session-Id': 'da94d2'
                    },
                    body: JSON.stringify({
                        sessionId: 'da94d2',
                        runId: 'voice-pre-fix',
                        hypothesisId: 'V2',
                        location: 'static/js/app.js:socket.webrtc_ice_candidate',
                        message: 'webrtc_ice_candidate applied',
                        data: {
                            selfUserId: userId,
                            roomId: currentRoomId,
                            fromUserId: data.from_user_id
                        },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion
            }
        } catch (error) {
            console.error('添加 ICE 候选失败:', error);
        }
    });

    socket.on('voice_error', (data) => {
        alert(data.message);
    });
}

// ========== WebRTC 核心功能 ==========

/**
 * 生成唯一的 Peer 连接 ID（排序确保两端一致）
 */
function getPeerId(user1, user2) {
    const arr = [user1, user2];
    arr.sort();
    return arr.join('-');
}

/**
 * 创建 Peer 连接
 * @param {string} targetUserId - 目标用户 ID
 * @param {boolean} isInitiator - 是否是发起者（发送 Offer）
 */
function createPeerConnection(targetUserId, isInitiator) {
    const peerId = getPeerId(targetUserId, userId);
    
    // 避免重复创建
    if (peerConnections[peerId]) {
        console.log('Peer 连接已存在:', peerId);
        return peerConnections[peerId];
    }

    console.log(`创建 Peer 连接：${userId} -> ${targetUserId}, 发起者：${isInitiator}`);

    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': 'da94d2'
        },
        body: JSON.stringify({
            sessionId: 'da94d2',
            runId: 'voice-pre-fix',
            hypothesisId: 'V2',
            location: 'static/js/app.js:createPeerConnection',
            message: 'createPeerConnection',
            data: {
                selfUserId: userId,
                roomId: currentRoomId,
                targetUserId,
                isInitiator
            },
            timestamp: Date.now()
        })
    }).catch(() => {});
    // #endregion

    const peerConnection = new RTCPeerConnection(rtcConfig);
    peerConnections[peerId] = peerConnection;

    // 添加本地音频流
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // 接收远端音频流
    peerConnection.ontrack = (event) => {
        console.log('收到远端音频流:', targetUserId);
        playRemoteStream(event.streams[0], targetUserId);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V4',
                location: 'static/js/app.js:peerConnection.ontrack',
                message: 'remote track received',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    fromUserId: targetUserId
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
    };

    // ICE 候选
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('发送 ICE 候选到:', targetUserId);
            socket.emit('webrtc_ice_candidate', {
                room_id: currentRoomId,
                target_user_id: targetUserId,
                candidate: event.candidate,
                from_user_id: userId
            });

            // #region agent log
            fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Debug-Session-Id': 'da94d2'
                },
                body: JSON.stringify({
                    sessionId: 'da94d2',
                    runId: 'voice-pre-fix',
                    hypothesisId: 'V2',
                    location: 'static/js/app.js:peerConnection.onicecandidate',
                    message: 'ice candidate sent',
                    data: {
                        selfUserId: userId,
                        roomId: currentRoomId,
                        targetUserId
                    },
                    timestamp: Date.now()
                })
            }).catch(() => {});
            // #endregion
        }
    };

    // 连接状态变化
    peerConnection.onconnectionstatechange = () => {
        console.log(`Peer 连接状态 (${targetUserId}):`, peerConnection.connectionState);
        
        if (peerConnection.connectionState === 'connected') {
            addVoiceParticipant(targetUserId);
        } else if (peerConnection.connectionState === 'failed' || 
                   peerConnection.connectionState === 'disconnected') {
            removeVoiceParticipant(targetUserId);
        }

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V4',
                location: 'static/js/app.js:peerConnection.onconnectionstatechange',
                message: 'connection state change',
                data: {
                    selfUserId: userId,
                    roomId: currentRoomId,
                    targetUserId,
                    state: peerConnection.connectionState
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
    };

    // 如果是发起者，创建并发送 Offer
    if (isInitiator) {
        setTimeout(async () => {
            try {
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                console.log('发送 Offer 到:', targetUserId);
                socket.emit('webrtc_offer', {
                    room_id: currentRoomId,
                    target_user_id: targetUserId,
                    offer: peerConnection.localDescription,
                    from_user_id: userId
                });
            } catch (error) {
                console.error('创建 Offer 失败:', error);
            }
        }, 100);
    }

    return peerConnection;
}

/**
 * 播放远端音频流
 */
function playRemoteStream(stream, userId) {
    // 检查是否已存在音频元素
    let audioEl = document.getElementById(`audio-${userId}`);
    
    if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `audio-${userId}`;
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        console.log('创建音频元素:', userId);
    }
    
    audioEl.srcObject = stream;
    audioEl.play().catch(e => {
        console.error('播放远端音频失败:', e);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V4',
                location: 'static/js/app.js:playRemoteStream',
                message: 'play remote audio failed',
                data: {
                    selfUserId: window.userId || null,
                    remoteUserId: userId,
                    errorName: e?.name || null,
                    errorMessage: e?.message || null
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
    });
}

// ========== 房间管理 ==========
function addRoomToList(roomId, name, type) {
    const container = document.getElementById('rooms-container');
    const existing = document.querySelector(`[data-room-id="${roomId}"]`);
    if (existing) {
        return;
    }

    const roomItem = document.createElement('div');
    roomItem.className = 'room-item';
    roomItem.setAttribute('data-room-id', roomId);
    roomItem.setAttribute('data-room-type', type);
    roomItem.innerHTML = `
        <div class="room-name">${name}</div>
        <div class="room-type">${type === 'private' ? '👤 双人聊天' : '👥 群聊'}</div>
    `;
    roomItem.addEventListener('click', () => openRoom(roomId, name, type));
    roomItem.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(roomId, e.pageX, e.pageY);
    });
    container.appendChild(roomItem);

    // 同步到「好友」和「群聊」分页
    addRoomToCategoryLists(roomId, name, type);
}

function addRoomToCategoryLists(roomId, name, type) {
    const isPrivate = type === 'private';
    const targetContainer = document.getElementById(isPrivate ? 'friends-list' : 'groups-list');
    if (!targetContainer) return;

    // 避免重复添加
    const existing = targetContainer.querySelector(`[data-room-id="${roomId}"]`);
    if (existing) return;

    const item = document.createElement('div');
    item.className = 'room-item';
    item.setAttribute('data-room-id', roomId);
    item.innerHTML = `
        <div class="room-name">${name}</div>
        <div class="room-type">${isPrivate ? '👤 双人聊天' : '👥 群聊'}</div>
    `;
    item.addEventListener('click', () => openRoom(roomId, name, type));
    item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(roomId, e.pageX, e.pageY);
    });

    // 如果有“暂无好友/群聊”提示，先清掉
    const emptyTip = targetContainer.querySelector('.empty-tip');
    if (emptyTip) {
        emptyTip.remove();
    }

    targetContainer.appendChild(item);
}

function openRoom(roomId, name, type) {
    console.log('打开房间:', roomId, name, type);

    if (!socket || !socket.connected) {
        socket = io();
        setTimeout(() => openRoom(roomId, name, type), 500);
        return;
    }

    socket.emit('join_invite', {
        user_id: userId,
        code: roomId
    });

    openChat(roomId, name, type, []);
}

// ========== 房间右键菜单 / 删除功能 ==========
function showContextMenu(roomId, x, y) {
    contextRoomId = roomId;
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.style.top = y + 'px';
    menu.style.left = x + 'px';
    menu.classList.remove('hidden');
}

function hideContextMenu() {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.classList.add('hidden');
}

window.addEventListener('click', () => {
    hideContextMenu();
});

function deleteRoom() {
    hideContextMenu();

    if (!contextRoomId) return;
    if (!confirm('确定要删除这个聊天吗？此操作会将所有成员移出该房间。')) return;

    socket.emit('delete_room', {
        user_id: userId,
        room_id: contextRoomId
    });
}

function removeRoomFromList(roomId) {
    // 侧边栏房间列表
    const sidebarItem = document.querySelector(`#rooms-container [data-room-id="${roomId}"]`);
    if (sidebarItem && sidebarItem.parentNode) {
        sidebarItem.parentNode.removeChild(sidebarItem);
    }

    // 好友分页
    const friendItem = document.querySelector(`#friends-list [data-room-id="${roomId}"]`);
    if (friendItem && friendItem.parentNode) {
        friendItem.parentNode.removeChild(friendItem);
    }

    // 群聊分页
    const groupItem = document.querySelector(`#groups-list [data-room-id="${roomId}"]`);
    if (groupItem && groupItem.parentNode) {
        groupItem.parentNode.removeChild(groupItem);
    }
}

function removeRoomFromStorage(roomId) {
    try {
        let rooms = JSON.parse(localStorage.getItem('mc_chat_rooms') || '[]');
        rooms = rooms.filter(r => r.roomId !== roomId);
        localStorage.setItem('mc_chat_rooms', JSON.stringify(rooms));
    } catch (e) {
        console.error('删除本地房间记录失败:', e);
    }
}

// ========== 聊天功能 ==========
function switchToChatView() {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const chatView = document.getElementById('view-chat');
    chatView.classList.remove('hidden');
    chatView.classList.add('active');
}

function openChat(roomId, name, type, members) {
    console.log('打开聊天窗口:', roomId, name, type, 'members:', members);

    currentRoomId = roomId;
    currentRoomType = type;

    switchToChatView();

    document.getElementById('chat-name').textContent = name;
    document.getElementById('chat-avatar').src = userAvatar || '/static/css/default-avatar.png';

    // 更新成员显示
    const memberCount = members && members.length > 0 ? members.length : 1;
    document.getElementById('chat-members').textContent = type === 'group'
        ? `${memberCount} 人在线`
        : '双人聊天';

    // 存储当前房间成员，用于语音连接
    window.currentRoomMembers = members || [];

    const voiceBtn = document.getElementById('voice-chat-btn');
    if (type === 'group') {
        voiceBtn.classList.remove('hidden');
        voiceBtn.disabled = false;
    } else {
        voiceBtn.classList.add('hidden');
        voiceBtn.disabled = true;
    }

    const container = document.getElementById('messages-container');
    container.innerHTML = '';

    // 显示/隐藏邀请按钮（仅群聊显示）
    const inviteBtn = document.getElementById('invite-to-room-btn');
    if (inviteBtn) {
        if (type === 'group') {
            inviteBtn.classList.remove('hidden');
        } else {
            inviteBtn.classList.add('hidden');
        }
    }

    // 如果是群聊，请求最新的成员列表
    if (type === 'group' && socket) {
        socket.emit('get_room_members', {
            user_id: userId,
            room_id: roomId
        });
    }
}

function appendMessage(data) {
    const container = document.getElementById('messages-container');
    const isOwn = data.user_id === userId;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${data.type}`;
    if (isOwn) messageDiv.style.flexDirection = 'row-reverse';

    const time = new Date(data.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    let contentHtml = data.content;
    if (data.type === 'voice') {
        // 语音消息：显示一个可点击的播放按钮
        contentHtml = `
            <button class="voice-play-btn" data-audio="data:audio/webm;base64,${data.content}">
                🎤 播放语音
            </button>
        `;
    }

    messageDiv.innerHTML = `
        <img class="message-avatar" src="${data.avatar || '/static/css/default-avatar.png'}" alt="">
        <div class="message-content">
            <div class="message-header">
                <span class="message-nickname">${data.nickname}</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-text">${contentHtml}</div>
        </div>
    `;

    container.appendChild(messageDiv);
    container.scrollTop = container.scrollHeight;

    // 如果是语音消息，为播放按钮绑定事件
    if (data.type === 'voice') {
        const playBtn = messageDiv.querySelector('.voice-play-btn');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                const src = playBtn.getAttribute('data-audio');
                if (!src) return;

                const audio = new Audio(src);

                // #region agent log
                fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Debug-Session-Id': 'da94d2'
                    },
                    body: JSON.stringify({
                        sessionId: 'da94d2',
                        runId: 'voice-message-debug',
                        hypothesisId: 'VM5',
                        location: 'static/js/app.js:appendMessage',
                        message: 'voice play clicked',
                        data: {
                            selfUserId: userId,
                            roomId: currentRoomId
                        },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion

                audio.play().catch(e => {
                    console.error('播放语音消息失败:', e);
                });
            });
        }
    }
}

function appendSystemMessage(text) {
    const container = document.getElementById('messages-container');
    const systemDiv = document.createElement('div');
    systemDiv.className = 'system-message';
    systemDiv.style.textAlign = 'center';
    systemDiv.style.color = '#888';
    systemDiv.style.padding = '10px';
    systemDiv.style.fontSize = '0.9rem';
    systemDiv.textContent = text;
    container.appendChild(systemDiv);
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const content = input.value.trim();

    if (!content || !currentRoomId) return;

    socket.emit('send_message', {
        user_id: userId,
        room_id: currentRoomId,
        content: content,
        type: 'text'
    });

    input.value = '';
}

document.getElementById('message-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// ========== 命令菜单 ==========
function showCommandsMenu() {
    const menu = document.getElementById('commands-menu');
    menu.classList.toggle('hidden');
}

document.querySelectorAll('.command-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        document.getElementById('commands-menu').classList.add('hidden');

        if (cmd === '/tp') {
            openModal('tp-modal');
        } else {
            handleCommand(cmd);
        }
    });
});

function handleCommand(cmd, params = {}) {
    let content = cmd;

    switch(cmd) {
        case '/tp':
            content = `/tp ${params.x || 0} ${params.y || 0} ${params.z || 0}`;
            break;
        case '/gamemode':
            content = `${cmd} creative/survival/adventure/spectator`;
            break;
        case '/time':
            content = `${cmd} set day/night`;
            break;
        case '/weather':
            content = `${cmd} clear/rain/thunder`;
            break;
        case '/give':
            content = `${cmd} <玩家> <物品> [数量]`;
            break;
        case '/spawnpoint':
            content = `${cmd} ~ ~ ~`;
            break;
        case '/difficulty':
            content = `${cmd} peaceful/easy/normal/hard`;
            break;
        case '/clear':
            content = `${cmd} [玩家] [物品]`;
            break;
        case '/effect':
            content = `${cmd} give <玩家> <效果>`;
            break;
        case '/xp':
            content = `${cmd} add <数量>`;
            break;
    }

    socket.emit('send_message', {
        user_id: userId,
        room_id: currentRoomId,
        content: content,
        type: 'command'
    });
}

function sendTpCommand() {
    const x = document.getElementById('coord-x').value || '0';
    const y = document.getElementById('coord-y').value || '0';
    const z = document.getElementById('coord-z').value || '0';

    handleCommand('/tp', { x, y, z });
    closeModal('tp-modal');
}

// ========== 语音消息 ==========
async function startRecording() {
    if (isRecording) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        mediaRecorder = new MediaRecorder(stream, {
            mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
        });
        audioChunks = [];
        recordStartTime = Date.now();

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-message-debug',
                hypothesisId: 'VM1',
                location: 'static/js/app.js:startRecording',
                message: 'voice recording started',
                data: {
                    userId,
                    roomId: currentRoomId
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
            }
        };

        mediaRecorder.onstop = async () => {
            const duration = Date.now() - recordStartTime;

            // 录音时长太短（例如误触/快速点击），不发送语音消息，只做清理
            if (duration < 300 || audioChunks.length === 0) {
                // #region agent log
                fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Debug-Session-Id': 'da94d2'
                    },
                    body: JSON.stringify({
                        sessionId: 'da94d2',
                        runId: 'voice-message-debug',
                        hypothesisId: 'VM2',
                        location: 'static/js/app.js:mediaRecorder.onstop',
                        message: 'voice recording too short, skipped',
                        data: {
                            userId,
                            roomId: currentRoomId,
                            duration,
                            chunks: audioChunks.length
                        },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion

                stream.getTracks().forEach(track => track.stop());
                return;
            }

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();

            reader.onloadend = () => {
                const base64Data = reader.result.split(',')[1];

                // #region agent log
                fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Debug-Session-Id': 'da94d2'
                    },
                    body: JSON.stringify({
                        sessionId: 'da94d2',
                        runId: 'voice-message-debug',
                        hypothesisId: 'VM3',
                        location: 'static/js/app.js:reader.onloadend',
                        message: 'voice message ready to send',
                        data: {
                            userId,
                            roomId: currentRoomId,
                            duration,
                            size: audioBlob.size
                        },
                        timestamp: Date.now()
                    })
                }).catch(() => {});
                // #endregion

                socket.emit('send_message', {
                    user_id: userId,
                    room_id: currentRoomId,
                    content: base64Data,
                    type: 'voice'
                });
            };

            reader.readAsDataURL(audioBlob);

            setTimeout(() => {
                stream.getTracks().forEach(track => track.stop());
            }, 100);
        };

        mediaRecorder.start();
        isRecording = true;

        const voiceBtn = document.getElementById('voice-btn');
        if (voiceBtn) voiceBtn.classList.add('recording');

        console.log('录音已开始');
    } catch (error) {
        console.error('录音失败:', error);
        let errorMsg = '无法访问麦克风';
        if (error.name === 'NotAllowedError') {
            errorMsg = '麦克风权限被拒绝';
        } else if (error.name === 'NotFoundError') {
            errorMsg = '未找到麦克风设备';
        }
        alert(errorMsg);
        isRecording = false;
        const voiceBtn = document.getElementById('voice-btn');
        if (voiceBtn) voiceBtn.classList.remove('recording');
    }
}

function stopRecording() {
    if (!isRecording || !mediaRecorder) return;

    try {
        if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
    } catch (e) {
        console.error('停止录音失败:', e);
    }

    isRecording = false;
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) voiceBtn.classList.remove('recording');
}

// ========== 邀请功能 ==========
function showInviteModal(type) {
    currentInviteType = type;
    document.getElementById('invite-title').textContent = type === 'friend' ? '创建好友邀请' : '创建群聊邀请';
    document.getElementById('invite-code-display').classList.add('hidden');
    openModal('invite-modal');
}

function showJoinModal(type) {
    currentInviteType = type;
    document.getElementById('join-title').textContent = type === 'friend' ? '加入好友聊天' : '加入群聊';
    document.getElementById('join-code-input').value = '';
    document.getElementById('join-error').classList.add('hidden');
    openModal('join-modal');
}

function createInvite() {
    const roomName = currentInviteType === 'group' ?
        `${userNickname}的群聊` : `${userNickname}的聊天`;

    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': 'da94d2'
        },
        body: JSON.stringify({
            sessionId: 'da94d2',
            runId: 'pre-fix',
            hypothesisId: 'H1',
            location: 'static/js/app.js:createInvite',
            message: 'createInvite called',
            data: {
                userId,
                currentInviteType,
                roomName
            },
            timestamp: Date.now()
        })
    }).catch(() => {});
    // #endregion

    socket.emit('create_invite', {
        user_id: userId,
        type: currentInviteType,
        room_name: roomName
    });
}

function showInviteCode(code) {
    document.getElementById('invite-code').textContent = code;
    document.getElementById('invite-code-display').classList.remove('hidden');
}

function copyInviteCode() {
    const code = document.getElementById('invite-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
        alert('邀请码已复制!');
    });
}

function joinInvite() {
    const code = document.getElementById('join-code-input').value.trim().toLowerCase();

    if (!userId) {
        document.getElementById('join-error').textContent = '用户未登录，请刷新页面';
        document.getElementById('join-error').classList.remove('hidden');
        return;
    }

    if (!code) {
        document.getElementById('join-error').textContent = '请输入邀请码';
        document.getElementById('join-error').classList.remove('hidden');
        return;
    }

    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': 'da94d2'
        },
        body: JSON.stringify({
            sessionId: 'da94d2',
            runId: 'pre-fix',
            hypothesisId: 'H1',
            location: 'static/js/app.js:joinInvite',
            message: 'joinInvite emit',
            data: {
                userId,
                code
            },
            timestamp: Date.now()
        })
    }).catch(() => {});
    // #endregion

    socket.emit('join_invite', {
        user_id: userId,
        code: code
    });
}

// ========== 邀请他人加入群聊 ==========

/**
 * 显示邀请他人加入群聊弹窗
 */
function showInviteToRoomModal() {
    if (!currentRoomId || currentRoomType !== 'group') {
        alert('只有群聊才能邀请他人');
        return;
    }
    openModal('invite-to-room-modal');
}

/**
 * 生成房间邀请码
 */
function generateRoomInviteCode() {
    if (!currentRoomId) {
        alert('请先加入群聊');
        return;
    }

    // 生成新的邀请码
    const newCode = generateInviteCode(6);
    
    // 保存到 invite_codes 映射
    socket.emit('create_invite', {
        user_id: userId,
        type: 'group',
        room_name: '',
        existing_room_id: currentRoomId,
        invite_code: newCode
    });

    // 显示邀请码
    document.getElementById('invite-to-room-code').textContent = newCode;
    document.getElementById('invite-to-room-code-display').classList.remove('hidden');
}

/**
 * 复制邀请码
 */
function copyInviteToRoomCode() {
    const code = document.getElementById('invite-to-room-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
        alert('邀请码已复制！分享给好友邀请他加入群聊吧！');
    }).catch(() => {
        alert('复制失败，请手动复制');
    });
}

/**
 * 生成随机邀请码
 */
function generateInviteCode(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ========== WebRTC 语音聊天 ==========

/**
 * 切换语音聊天状态
 */
function toggleVoiceChat() {
    if (!currentRoomId) {
        alert('请先加入群聊');
        return;
    }

    if (currentRoomType !== 'group') {
        alert('只有群聊才能使用语音聊天功能');
        return;
    }

    if (isVoiceChatActive) {
        leaveVoiceChat();
    } else {
        startVoiceChat();
    }
}

/**
 * 开始语音聊天
 */
async function startVoiceChat() {
    console.log('开始语音聊天，房间:', currentRoomId, '成员:', window.currentRoomMembers);

    try {
        // 获取本地音频流
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000
            }
        });

        console.log('麦克风已开启');

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V1',
                location: 'static/js/app.js:startVoiceChat',
                message: 'startVoiceChat success',
                data: {
                    userId,
                    roomId: currentRoomId
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion
        isVoiceChatActive = true;

        // 设置自己的名字在语音面板
        document.getElementById('voice-self-name').textContent = userNickname;

        // 先加入语音房间
        socket.emit('join_voice_room', {
            user_id: userId,
            room_id: currentRoomId
        });

        // 为所有其他成员创建 Peer 连接
        if (window.currentRoomMembers && window.currentRoomMembers.length > 0) {
            console.log('为房间成员创建 Peer 连接:', window.currentRoomMembers);
            window.currentRoomMembers.forEach(member => {
                if (member.user_id !== userId) {
                    createPeerConnection(member.user_id, true);
                }
            });
        }

        showVoicePanel();
    } catch (error) {
        console.error('获取麦克风失败:', error);

        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': 'da94d2'
            },
            body: JSON.stringify({
                sessionId: 'da94d2',
                runId: 'voice-pre-fix',
                hypothesisId: 'V3',
                location: 'static/js/app.js:startVoiceChat',
                message: 'startVoiceChat getUserMedia failed',
                data: {
                    userId,
                    roomId: currentRoomId,
                    errorName: error?.name || null,
                    errorMessage: error?.message || null
                },
                timestamp: Date.now()
            })
        }).catch(() => {});
        // #endregion

        alert('无法访问麦克风，请检查权限设置');
    }
}

/**
 * 离开语音聊天
 */
function leaveVoiceChat() {
    console.log('离开语音聊天');

    // 关闭所有 Peer 连接
    Object.values(peerConnections).forEach(pc => {
        if (pc) {
            pc.close();
        }
    });
    peerConnections = {};

    // 停止本地音频流
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // 移除所有音频元素
    document.querySelectorAll('[id^="audio-"]').forEach(el => el.remove());

    // 通知服务器
    socket.emit('leave_voice_room', {
        user_id: userId,
        room_id: currentRoomId
    });

    isVoiceChatActive = false;
    hideVoicePanel();

    // 离开语音时，清理本地待加入语音邀请
    pendingVoiceInviteRoomId = null;
    pendingVoiceInviteFromUser = null;

    const notif = document.getElementById('voice-notification');
    if (notif) {
        notif.classList.add('hidden');
    }
}

/**
 * 显示语音面板
 */
function showVoicePanel() {
    document.getElementById('voice-panel').classList.remove('hidden');
}

/**
 * 隐藏语音面板
 */
function hideVoicePanel() {
    document.getElementById('voice-panel').classList.add('hidden');
}

/**
 * 加入收到的语音邀请
 */
async function joinIncomingVoiceChat() {
    const notif = document.getElementById('voice-notification');
    if (notif) {
        notif.classList.add('hidden');
    }

    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/e627f496-4fc2-4664-a071-745b69789d36', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': 'da94d2'
        },
        body: JSON.stringify({
            sessionId: 'da94d2',
            runId: 'voice-pre-fix-2',
            hypothesisId: 'V1',
            location: 'static/js/app.js:joinIncomingVoiceChat',
            message: 'join incoming voice invite',
            data: {
                selfUserId: userId,
                roomId: currentRoomId,
                pendingRoomId: pendingVoiceInviteRoomId,
                fromUser: pendingVoiceInviteFromUser
            },
            timestamp: Date.now()
        })
    }).catch(() => {});
    // #endregion

    // 直接调用已有的语音开始逻辑
    if (currentRoomId === pendingVoiceInviteRoomId) {
        startVoiceChat();
    } else if (!currentRoomId) {
        alert('请先进入群聊再加入语音');
    } else {
        // 房间已切换，仍尝试加入当前房间的语音
        startVoiceChat();
    }
}

/**
 * 添加语音参与者到面板
 */
function addVoiceParticipant(uid) {
    const container = document.getElementById('voice-participants');
    
    // 检查是否已存在
    if (document.getElementById(`voice-user-${uid}`)) {
        return;
    }

    const div = document.createElement('div');
    div.className = 'voice-participant';
    div.id = `voice-user-${uid}`;
    
    // 获取用户昵称
    const nickname = (uid === userId) ? userNickname : '用户';
    
    div.innerHTML = `
        <span class="status-dot"></span>
        <span>${nickname}</span>
    `;
    container.appendChild(div);
    console.log('添加语音参与者:', uid, nickname);
}

/**
 * 从面板移除语音参与者
 */
function removeVoiceParticipant(uid) {
    const el = document.getElementById(`voice-user-${uid}`);
    if (el) {
        el.remove();
        console.log('移除语音参与者:', uid);
    }
}

/**
 * 切换静音
 */
function toggleMute() {
    isMuted = !isMuted;
    const btn = document.getElementById('mute-btn');

    if (isMuted) {
        btn.classList.add('muted');
        btn.textContent = '🔇 已静音';
        if (localStream) {
            localStream.getAudioTracks()[0].enabled = false;
        }
    } else {
        btn.classList.remove('muted');
        btn.textContent = '🔊 静音';
        if (localStream) {
            localStream.getAudioTracks()[0].enabled = true;
        }
    }
}

// ========== 视图切换 ==========
function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.remove('active');
        v.classList.add('hidden');
    });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const targetView = document.getElementById(`view-${viewName}`);
    if (targetView) {
        targetView.classList.remove('hidden');
        targetView.classList.add('active');
    }

    const navBtn = document.querySelector(`[data-view="${viewName}"]`);
    if (navBtn) navBtn.classList.add('active');
}

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        showView(btn.dataset.view);
    });
});

// ========== 弹窗控制 ==========
function openModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
        }
    });
});

// ========== 页面卸载 ==========
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    Object.values(peerConnections).forEach(pc => {
        if (pc) {
            pc.close();
        }
    });
});
