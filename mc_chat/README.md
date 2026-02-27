# Minecraft 聊天室 - WebRTC 多人语音聊天

## 架构说明

本项目使用 **WebRTC Mesh 架构** 实现多人语音聊天：

- **信令服务器**: Flask + Flask-SocketIO
- **点对点连接**: 客户端之间直接建立 WebRTC 连接
- **音频传输**: 通过 WebRTC PeerConnection 直接传输，无需服务器中转

## 工作原理

### 1. Mesh 架构
```
用户 A ←---→ 用户 B
  ↑           ↑
  └----→ 用户 C ←---┘
```
每个用户与其他所有用户建立点对点连接，音频流直接在客户端之间传输。

### 2. 连接建立流程
```
1. 用户 A 加入语音房间
   ↓
2. 用户 B 加入语音房间
   ↓
3. B 向 A 发送 WebRTC Offer（通过信令服务器转发）
   ↓
4. A 回复 Answer 给 B
   ↓
5. 双方交换 ICE 候选
   ↓
6. PeerConnection 建立，开始音频传输
   ↓
7. 用户 C 加入，向 A、B 分别发送 Offer
   ↓
8. 形成完整的 Mesh 网络
```

### 3. 信令消息
- `webrtc_offer`: 转发 WebRTC Offer
- `webrtc_answer`: 转发 WebRTC Answer
- `webrtc_ice_candidate`: 转发 ICE 候选
- `join_voice_room`: 加入语音房间
- `leave_voice_room`: 离开语音房间

## 使用方法

### 1. 启动服务器
```bash
cd d:\py\myworks\我的世界\mc_chat
python app.py
```

服务器将在 http://localhost:2250 启动

### 2. 用户加入
1. 打开浏览器访问 http://localhost:2250
2. 输入昵称
3. 上传皮肤（可选）
4. 点击"进入聊天室"

### 3. 创建群聊
1. 点击"创建群聊"
2. 复制邀请码
3. 在另一个浏览器窗口打开页面
4. 点击"加入群聊"，粘贴邀请码

### 4. 开始语音聊天
1. 进入群聊后，点击右上角"🎤 语音聊天"按钮
2. 允许浏览器访问麦克风
3. 语音面板将显示所有参与者
4. 其他用户加入群聊后，自动建立语音连接

## 核心代码说明

### 后端信令处理 (app.py)

```python
@socketio.on('webrtc_offer')
def handle_offer(data):
    """转发 WebRTC Offer"""
    room_id = data.get('room_id')
    emit('webrtc_offer', {
        'from_user_id': from_user_id,
        'offer': offer
    }, room=room_id)

@socketio.on('join_voice_room')
def handle_join_voice_room(data):
    """加入语音房间 - 通知其他人"""
    # 通知房间内其他人有新用户加入
    emit('user_joined_voice', {
        'user_id': user_id,
        'existing_users': other_users
    }, room=room_id)
```

### 前端 PeerConnection 创建 (app.js)

```javascript
function createPeerConnection(targetUserId, isInitiator) {
    const peerId = getPeerId(targetUserId, userId);
    const peerConnection = new RTCPeerConnection(rtcConfig);
    
    // 添加本地音频流
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });
    
    // 接收远端音频流
    peerConnection.ontrack = (event) => {
        playRemoteStream(event.streams[0], targetUserId);
    };
    
    // ICE 候选交换
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc_ice_candidate', {...});
        }
    };
    
    // 发起者发送 Offer
    if (isInitiator) {
        const offer = await peerConnection.createOffer();
        socket.emit('webrtc_offer', {...});
    }
}
```

## 关键技术点

### 1. Peer ID 生成
```javascript
function getPeerId(user1, user2) {
    const arr = [user1, user2].sort();
    return arr.join('-');  // 确保两端生成相同的 ID
}
```

### 2. 连接顺序规则
- **后加入的成员向房间内所有已加入成员发送 Offer**
- 避免连接混乱

### 3. STUN 服务器
```javascript
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};
```

### 4. 音频播放
```javascript
function playRemoteStream(stream, userId) {
    let audioEl = document.getElementById(`audio-${userId}`);
    if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `audio-${userId}`;
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
}
```

## 优势

1. **低延迟**: 点对点直接传输，无需服务器中转
2. **节省带宽**: 服务器只处理信令，不处理音频流
3. **去中心化**: 没有单点故障
4. **自动扩展**: 新用户加入时自动建立连接

## 限制

1. **连接数限制**: 每个用户需要与其他所有用户建立连接，用户过多时带宽压力大
   - 建议最多 10 人以内
2. **NAT 穿透**: 复杂网络环境可能需要 TURN 服务器
3. **浏览器兼容性**: 需要支持 WebRTC 的现代浏览器

## 故障排除

### 1. 麦克风权限被拒绝
- 检查浏览器权限设置
- 确保使用 HTTPS 或 localhost

### 2. 无法建立连接
- 检查防火墙设置
- 可能需要配置 TURN 服务器

### 3. 听不到声音
- 检查浏览器是否自动播放音频被阻止
- 检查系统音量设置
- 确认对方麦克风正常工作

## 参考资料

- [WebRTC 官方文档](https://webrtc.org/)
- [MDN WebRTC API](https://developer.mozilla.org/zh-CN/docs/Web/API/WebRTC_API)
- [WebRTC 多人视频聊天实现](https://cloud.tencent.com/developer/article/1615486)
