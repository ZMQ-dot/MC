"""
Minecraft 聊天室后端 - Flask + Flask-SocketIO
支持 WebRTC 多人语音聊天
"""
import os
import random
import string
import uuid
import json
import time
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from werkzeug.utils import secure_filename
from PIL import Image
import base64
from io import BytesIO

app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24)
app.config['UPLOAD_FOLDER'] = 'static/skins'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

ALLOWED_EXTENSIONS = {'png'}

# 内存数据存储
users = {}  # user_id -> {nickname, skin_path, avatar, socket_id}
rooms = {}  # room_id -> {type, name, members: [user_ids], messages: []}
user_rooms = {}  # user_id -> [room_ids]
room_peers = {}  # room_id -> {user_id: socket_id}  # 用于 WebRTC 信令

# 邀请码映射：短邀请码 -> 房间 ID
invite_codes = {}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def generate_invite_code(length=6):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=length))

def extract_avatar(skin_path):
    try:
        img = Image.open(skin_path)
        face = img.crop((8, 8, 16, 16))
        avatar = face.resize((64, 64), Image.NEAREST)
        buffer = BytesIO()
        avatar.save(buffer, format='PNG')
        avatar_base64 = base64.b64encode(buffer.getvalue()).decode()
        return f"data:image/png;base64,{avatar_base64}"
    except Exception as e:
        print(f"提取头像失败：{e}")
        return None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/login', methods=['POST'])
def login():
    nickname = request.form.get('nickname', '').strip()
    print(f'登录请求 - nickname: {nickname}')

    if not nickname:
        return jsonify({'success': False, 'message': '请输入昵称'})

    user_id = str(uuid.uuid4())
    users[user_id] = {
        'nickname': nickname,
        'skin_path': None,
        'avatar': None,
        'socket_id': None
    }

    print(f'登录成功 - user_id: {user_id}, nickname: {nickname}')
    return jsonify({'success': True, 'user_id': user_id, 'nickname': nickname})

@app.route('/upload_skin', methods=['POST'])
def upload_skin():
    user_id = request.form.get('user_id')

    if not user_id or user_id not in users:
        return jsonify({'success': False, 'message': '用户不存在'})

    if 'skin' not in request.files:
        return jsonify({'success': False, 'message': '没有上传文件'})

    file = request.files['skin']
    if file.filename == '':
        return jsonify({'success': False, 'message': '没有选择文件'})

    if file and allowed_file(file.filename):
        filename = secure_filename(f"{user_id}_{file.filename}")
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        avatar = extract_avatar(filepath)
        users[user_id]['skin_path'] = filepath
        users[user_id]['avatar'] = avatar

        return jsonify({
            'success': True,
            'skin_url': f'/static/skins/{filename}',
            'avatar': avatar
        })

    return jsonify({'success': False, 'message': '只支持 PNG 格式文件'})

@app.route('/static/skins/<filename>')
def serve_skin(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# ==================== WebSocket 事件 ====================

@socketio.on('connect')
def handle_connect():
    print(f'用户连接：{request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    print(f'用户断开：{request.sid}')
    
    # 清理用户数据
    for user_id, data in users.items():
        if data.get('socket_id') == request.sid:
            # 从所有房间移除
            for room_id in list(user_rooms.get(user_id, [])):
                if room_id in rooms:
                    if user_id in rooms[room_id]['members']:
                        rooms[room_id]['members'].remove(user_id)
                    
                    # 通知其他人用户离开
                    emit('user_left', {
                        'user_id': user_id,
                        'nickname': data['nickname']
                    }, room=room_id)
                
                # 清理 WebRTC 信令数据
                if room_id in room_peers:
                    if user_id in room_peers[room_id]:
                        del room_peers[room_id][user_id]
            
            if user_id in user_rooms:
                del user_rooms[user_id]
            
            # 从全局用户列表移除
            if user_id in users:
                del users[user_id]
            break

@socketio.on('register_user')
def handle_register(data):
    user_id = data.get('user_id')
    if user_id and user_id in users:
        users[user_id]['socket_id'] = request.sid
        print(f'用户 {user_id} 注册 socket: {request.sid}')

@socketio.on('create_invite')
def handle_create_invite(data):
    user_id = data.get('user_id')
    invite_type = data.get('type', 'friend')
    room_name = data.get('room_name', '群聊')
    existing_room_id = data.get('existing_room_id')
    invite_code = data.get('invite_code')

    if not user_id or user_id not in users:
        emit('invite_error', {'message': '用户不存在'})
        return

    # 如果是为已有房间生成邀请码
    if existing_room_id and existing_room_id in rooms:
        room = rooms[existing_room_id]
        if room['type'] != 'group':
            emit('invite_error', {'message': '只有群聊才能邀请他人'})
            return
        
        # 检查用户是否是房间成员
        if user_id not in room['members']:
            emit('invite_error', {'message': '您不是该房间成员'})
            return
        
        # 生成邀请码（使用传入的或新生成）
        code = invite_code if invite_code else generate_invite_code()
        invite_codes[code] = existing_room_id
        
        emit('invite_to_room_success', {
            'room_id': existing_room_id,
            'room_name': room['name'],
            'invite_code': code,
            'inviter_nickname': users[user_id]['nickname']
        })
        return

    # 创建新房间
    code = generate_invite_code()
    room_id = str(uuid.uuid4())

    # 记录邀请码与房间 ID 的映射，供后续通过短码加入
    invite_codes[code] = room_id

    # region agent log
    try:
        log_entry = {
            "sessionId": "da94d2",
            "id": f"log_{int(time.time() * 1000)}",
            "timestamp": int(time.time() * 1000),
            "location": "app.py:handle_create_invite",
            "message": "create_invite generated",
            "data": {
                "user_id": user_id,
                "invite_type": invite_type,
                "room_name": room_name,
                "room_id": room_id,
                "code": code
            },
            "runId": "pre-fix",
            "hypothesisId": "H1"
        }
        with open("debug-da94d2.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # endregion

    rooms[room_id] = {
        'type': 'private' if invite_type == 'friend' else 'group',
        'name': room_name if invite_type == 'group' else f'{users[user_id]["nickname"]}的聊天',
        'members': [user_id],
        'messages': []
    }

    room_peers[room_id] = {user_id: request.sid}
    user_rooms[user_id] = [room_id]
    join_room(room_id)

    emit('invite_created', {
        'code': code,
        'room_id': room_id,
        'type': invite_type,
        'room_name': rooms[room_id]['name']
    })

@socketio.on('join_invite')
def handle_join_invite(data):
    user_id = data.get('user_id')
    code = data.get('code', '').strip().lower()

    print(f'加入邀请 - user_id: {user_id}, code: {code}')

    # region agent log
    try:
        log_entry = {
            "sessionId": "da94d2",
            "id": f"log_{int(time.time() * 1000)}",
            "timestamp": int(time.time() * 1000),
            "location": "app.py:handle_join_invite",
            "message": "join_invite received",
            "data": {
                "user_id": user_id,
                "raw_code": code
            },
            "runId": "pre-fix",
            "hypothesisId": "H1"
        }
        with open("debug-da94d2.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # endregion

    if not user_id or user_id not in users:
        emit('join_error', {'message': '用户不存在'})
        return

    room_id = None
    resolve_source = None

    # 1) 优先尝试使用短邀请码映射
    if code in invite_codes:
        room_id = invite_codes[code]
        resolve_source = 'short_code'
    else:
        # 2) 再尝试把 code 当作房间 UUID 处理（兼容直接使用 room_id 的情况）
        try:
            uuid.UUID(code)
            room_id = code
            resolve_source = 'room_id'
        except ValueError:
            # region agent log
            try:
                log_entry = {
                    "sessionId": "da94d2",
                    "id": f"log_{int(time.time() * 1000)}",
                    "timestamp": int(time.time() * 1000),
                    "location": "app.py:handle_join_invite",
                    "message": "join_invite invalid_code",
                    "data": {
                        "user_id": user_id,
                        "raw_code": code
                    },
                    "runId": "pre-fix",
                    "hypothesisId": "H1"
                }
                with open("debug-da94d2.log", "a", encoding="utf-8") as f:
                    f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
            except Exception:
                pass
            # endregion
            emit('join_error', {'message': '无效的邀请码'})
            return

    if room_id not in rooms:
        emit('join_error', {'message': '房间不存在'})
        return

    room = rooms[room_id]

    # region agent log
    try:
        log_entry = {
            "sessionId": "da94d2",
            "id": f"log_{int(time.time() * 1000)}",
            "timestamp": int(time.time() * 1000),
            "location": "app.py:handle_join_invite",
            "message": "join_invite success",
            "data": {
                "user_id": user_id,
                "room_id": room_id,
                "resolve_source": resolve_source,
                "room_type": room['type'],
                "member_count": len(room['members'])
            },
            "runId": "pre-fix",
            "hypothesisId": "H1"
        }
        with open("debug-da94d2.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # endregion

    is_new_member = False
    if user_id not in room['members']:
        room['members'].append(user_id)
        is_new_member = True

    # 添加到房间对等列表
    if room_id not in room_peers:
        room_peers[room_id] = {}
    room_peers[room_id][user_id] = request.sid

    if user_id not in user_rooms:
        user_rooms[user_id] = []
    if room_id not in user_rooms[user_id]:
        user_rooms[user_id].append(room_id)

    join_room(room_id)
    users[user_id]['socket_id'] = request.sid

    # 通知其他人（仅当是新成员时）
    if is_new_member:
        emit('user_joined', {
            'user_id': user_id,
            'nickname': users[user_id]['nickname'],
            'avatar': users[user_id]['avatar']
        }, room=room_id, include_self=False)

    # 返回房间信息 - 确保包含所有成员
    members_info = []
    for uid in room['members']:
        if uid in users:
            members_info.append({
                'user_id': uid,
                'nickname': users[uid]['nickname'],
                'avatar': users[uid]['avatar']
            })

    emit('join_success', {
        'room_id': room_id,
        'room_name': room['name'],
        'room_type': room['type'],
        'members': members_info,
        'messages': room['messages'][-50:]
    })

@socketio.on('send_message')
def handle_message(data):
    user_id = data.get('user_id')
    room_id = data.get('room_id')
    content = data.get('content', '').strip()
    message_type = data.get('type', 'text')

    if not user_id or user_id not in users:
        emit('message_error', {'message': '用户不存在'})
        return

    if not room_id or room_id not in rooms:
        emit('message_error', {'message': '房间不存在'})
        return

    if not content:
        emit('message_error', {'message': '消息不能为空'})
        return

    user = users[user_id]

    # region agent log
    try:
        log_entry = {
            "sessionId": "da94d2",
            "id": f"log_{int(time.time() * 1000)}",
            "timestamp": int(time.time() * 1000),
            "location": "app.py:handle_message",
            "message": "incoming message",
            "data": {
                "user_id": user_id,
                "room_id": room_id,
                "type": message_type,
                "content_length": len(content)
            },
            "runId": "voice-message-debug",
            "hypothesisId": "VM4"
        }
        with open("debug-da94d2.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # endregion
    message = {
        'id': str(uuid.uuid4()),
        'user_id': user_id,
        'nickname': user['nickname'],
        'avatar': user['avatar'],
        'content': content,
        'type': message_type,
        'timestamp': datetime.now().isoformat()
    }

    rooms[room_id]['messages'].append(message)
    if len(rooms[room_id]['messages']) > 100:
        rooms[room_id]['messages'] = rooms[room_id]['messages'][-100:]

    emit('new_message', message, room=room_id)

# ==================== WebRTC 信令服务 ====================

@socketio.on('webrtc_offer')
def handle_offer(data):
    """转发 WebRTC Offer"""
    room_id = data.get('room_id')
    target_user_id = data.get('target_user_id')
    offer = data.get('offer')
    from_user_id = data.get('from_user_id')

    if room_id and target_user_id and offer:
        print(f'转发 Offer: {from_user_id} -> {target_user_id}')

        # region agent log
        try:
            log_entry = {
                "sessionId": "da94d2",
                "id": f"log_{int(time.time() * 1000)}",
                "timestamp": int(time.time() * 1000),
                "location": "app.py:handle_offer",
                "message": "webrtc_offer received",
                "data": {
                    "room_id": room_id,
                    "from_user_id": from_user_id,
                    "target_user_id": target_user_id,
                    "has_offer": offer is not None
                },
                "runId": "voice-pre-fix",
                "hypothesisId": "V2"
            }
            with open("debug-da94d2.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # endregion

        # 获取目标用户的 socket_id，仅转发给目标用户
        if room_id in room_peers and target_user_id in room_peers[room_id]:
            target_socket = room_peers[room_id][target_user_id]
            emit('webrtc_offer', {
                'from_user_id': from_user_id,
                'from_nickname': users.get(from_user_id, {}).get('nickname', '未知'),
                'offer': offer
            }, to=target_socket)

@socketio.on('webrtc_answer')
def handle_answer(data):
    """转发 WebRTC Answer"""
    room_id = data.get('room_id')
    target_user_id = data.get('target_user_id')
    answer = data.get('answer')
    from_user_id = data.get('from_user_id')

    if room_id and target_user_id and answer:
        print(f'转发 Answer: {from_user_id} -> {target_user_id}')

        # region agent log
        try:
            log_entry = {
                "sessionId": "da94d2",
                "id": f"log_{int(time.time() * 1000)}",
                "timestamp": int(time.time() * 1000),
                "location": "app.py:handle_answer",
                "message": "webrtc_answer received",
                "data": {
                    "room_id": room_id,
                    "from_user_id": from_user_id,
                    "target_user_id": target_user_id,
                    "has_answer": answer is not None
                },
                "runId": "voice-pre-fix",
                "hypothesisId": "V2"
            }
            with open("debug-da94d2.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # endregion

        if room_id in room_peers and target_user_id in room_peers[room_id]:
            target_socket = room_peers[room_id][target_user_id]
            emit('webrtc_answer', {
                'from_user_id': from_user_id,
                'answer': answer
            }, to=target_socket)

@socketio.on('webrtc_ice_candidate')
def handle_ice_candidate(data):
    """转发 ICE 候选"""
    room_id = data.get('room_id')
    target_user_id = data.get('target_user_id')
    candidate = data.get('candidate')
    from_user_id = data.get('from_user_id')

    if room_id and target_user_id and candidate:
        # region agent log
        try:
            log_entry = {
                "sessionId": "da94d2",
                "id": f"log_{int(time.time() * 1000)}",
                "timestamp": int(time.time() * 1000),
                "location": "app.py:handle_ice_candidate",
                "message": "webrtc_ice_candidate received",
                "data": {
                    "room_id": room_id,
                    "from_user_id": from_user_id,
                    "target_user_id": target_user_id
                },
                "runId": "voice-pre-fix",
                "hypothesisId": "V2"
            }
            with open("debug-da94d2.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # endregion

        if room_id in room_peers and target_user_id in room_peers[room_id]:
            target_socket = room_peers[room_id][target_user_id]
            emit('webrtc_ice_candidate', {
                'from_user_id': from_user_id,
                'candidate': candidate
            }, to=target_socket)

@socketio.on('delete_room')
def handle_delete_room(data):
    """删除群聊或双人聊天房间"""
    user_id = data.get('user_id')
    room_id = data.get('room_id')

    # 如果房间 ID 无效，直接告诉前端当作已删除处理（幂等）
    if not room_id:
        emit('room_deleted', {
            'room_id': room_id,
            'room_name': '',
            'initiator_id': user_id,
            'initiator_nickname': users.get(user_id, {}).get('nickname', '')
        }, to=request.sid)
        return

    room = rooms.get(room_id)

    # 房间在服务端已经不存在：仍然给当前用户一个 room_deleted，用于清理本地 UI
    if not room:
        emit('room_deleted', {
            'room_id': room_id,
            'room_name': '',
            'initiator_id': user_id,
            'initiator_nickname': users.get(user_id, {}).get('nickname', '')
        }, to=request.sid)
        return

    # 用户在服务端不存在：同样只做本地清理，不修改全局 rooms
    if not user_id or user_id not in users:
        emit('room_deleted', {
            'room_id': room_id,
            'room_name': room['name'],
            'initiator_id': user_id,
            'initiator_nickname': ''
        }, to=request.sid)
        return

    # 如果用户不在房间成员列表中，只删除自己本地的房间记录，不影响全局房间
    if user_id not in room['members']:
        emit('room_deleted', {
            'room_id': room_id,
            'room_name': room['name'],
            'initiator_id': user_id,
            'initiator_nickname': users.get(user_id, {}).get('nickname', '')
        }, to=request.sid)
        return

    # 从用户的房间列表中移除该房间
    for uid, r_list in list(user_rooms.items()):
        if room_id in r_list:
            r_list.remove(room_id)
            if not r_list:
                del user_rooms[uid]

    # 从 WebRTC 对等表中移除
    if room_id in room_peers:
        del room_peers[room_id]

    # 从邀请码表中移除指向该房间的短码
    codes_to_delete = [code for code, rid in invite_codes.items() if rid == room_id]
    for code in codes_to_delete:
        del invite_codes[code]

    # 向房间内所有用户广播房间被删除
    emit('room_deleted', {
        'room_id': room_id,
        'room_name': room['name'],
        'initiator_id': user_id,
        'initiator_nickname': users.get(user_id, {}).get('nickname', '')
    }, room=room_id)

    # 最后从 rooms 中删除
    del rooms[room_id]

@socketio.on('join_voice_room')
def handle_join_voice_room(data):
    """加入语音房间 - 通知其他人开始 WebRTC 连接"""
    user_id = data.get('user_id')
    room_id = data.get('room_id')

    if not room_id or room_id not in rooms:
        emit('voice_error', {'message': '房间不存在'})
        return

    # 更新房间对等列表
    if room_id not in room_peers:
        room_peers[room_id] = {}
    room_peers[room_id][user_id] = request.sid
    users[user_id]['socket_id'] = request.sid

    # 获取房间内其他用户
    other_users = [
        {
            'user_id': uid,
            'nickname': users[uid]['nickname'],
            'avatar': users[uid]['avatar']
        }
        for uid in rooms[room_id]['members']
        if uid != user_id
    ]

    # region agent log
    try:
        log_entry = {
            "sessionId": "da94d2",
            "id": f"log_{int(time.time() * 1000)}",
            "timestamp": int(time.time() * 1000),
            "location": "app.py:handle_join_voice_room",
            "message": "join_voice_room",
            "data": {
                "room_id": room_id,
                "user_id": user_id,
                "other_user_ids": [u["user_id"] for u in other_users],
                "room_member_count": len(rooms[room_id]['members'])
            },
            "runId": "voice-pre-fix",
            "hypothesisId": "V1"
        }
        with open("debug-da94d2.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # endregion

    # 通知房间内其他人有新用户加入语音
    emit('user_joined_voice', {
        'user_id': user_id,
        'nickname': users[user_id]['nickname'],
        'avatar': users[user_id]['avatar'],
        'existing_users': other_users
    }, room=room_id)

    # 返回房间内现有用户列表给新加入者
    emit('voice_room_users', {
        'users': other_users
    })

@socketio.on('leave_voice_room')
def handle_leave_voice_room(data):
    """离开语音房间"""
    user_id = data.get('user_id')
    room_id = data.get('room_id')

    if room_id and room_id in room_peers:
        if user_id in room_peers[room_id]:
            del room_peers[room_id][user_id]

        # region agent log
        try:
            log_entry = {
                "sessionId": "da94d2",
                "id": f"log_{int(time.time() * 1000)}",
                "timestamp": int(time.time() * 1000),
                "location": "app.py:handle_leave_voice_room",
                "message": "leave_voice_room",
                "data": {
                    "room_id": room_id,
                    "user_id": user_id,
                    "remaining_peers": list(room_peers.get(room_id, {}).keys())
                },
                "runId": "voice-pre-fix",
                "hypothesisId": "V1"
            }
            with open("debug-da94d2.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # endregion

        emit('user_left_voice', {
            'user_id': user_id,
            'nickname': users.get(user_id, {}).get('nickname', '未知')
        }, room=room_id)

@socketio.on('get_rooms')
def handle_get_rooms(data):
    user_id = data.get('user_id')

    if not user_id or user_id not in users:
        emit('rooms_list', {'rooms': []})
        return

    room_list = []
    for room_id in user_rooms.get(user_id, []):
        if room_id in rooms:
            room = rooms[room_id]
            room_list.append({
                'room_id': room_id,
                'name': room['name'],
                'type': room['type'],
                'member_count': len(room['members'])
            })

    emit('rooms_list', {'rooms': room_list})

@socketio.on('invite_to_room')
def handle_invite_to_room(data):
    """邀请用户加入已有群聊"""
    inviter_user_id = data.get('user_id')
    room_id = data.get('room_id')
    new_invite_code = data.get('invite_code')

    if not inviter_user_id or inviter_user_id not in users:
        emit('invite_to_room_error', {'message': '用户不存在'})
        return

    if not room_id or room_id not in rooms:
        emit('invite_to_room_error', {'message': '房间不存在'})
        return

    room = rooms[room_id]
    if room['type'] != 'group':
        emit('invite_to_room_error', {'message': '只有群聊才能邀请他人'})
        return

    # 验证邀请码
    if new_invite_code not in invite_codes or invite_codes[new_invite_code] != room_id:
        emit('invite_to_room_error', {'message': '无效的邀请码'})
        return

    # 生成可分享的邀请信息
    emit('invite_to_room_success', {
        'room_id': room_id,
        'room_name': room['name'],
        'invite_code': new_invite_code,
        'inviter_nickname': users[inviter_user_id]['nickname']
    })

@socketio.on('get_room_members')
def handle_get_room_members(data):
    """获取房间成员列表"""
    user_id = data.get('user_id')
    room_id = data.get('room_id')

    if not room_id or room_id not in rooms:
        emit('room_members_list', {'members': []})
        return

    room = rooms[room_id]
    members_info = []
    for uid in room['members']:
        if uid in users:
            members_info.append({
                'user_id': uid,
                'nickname': users[uid]['nickname'],
                'avatar': users[uid]['avatar']
            })

    emit('room_members_list', {
        'room_id': room_id,
        'members': members_info,
        'member_count': len(members_info)
    })

if __name__ == '__main__':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    socketio.run(app, debug=True, host='0.0.0.0', port=2250)
