let socket = null;
let currentChatPartner = null; // 現在チャット中の相手のメールアドレス
let currentSessionKey = null;  // 現在の相手との個別暗号鍵（16進数文字列）
let activeFriends = [];        // 鍵交換済みお友達リスト
let currentPendingNotif = null;// 届いている未承認の申請情報
let idTimerInterval = null; // ワンタイムID残り時間管理用

window.onload = async function() {
    if (!localStorage.getItem('session_email') || !localStorage.getItem('session_hash')) {
        location.href = '/login.html'; return;
    }
    document.getElementById('my-login-email').innerText = localStorage.getItem('session_email');

    socket = io();
    socket.on('update_user_count', (data) => { document.getElementById('user-count').innerText = data.count; });
    
    // リアルタイム通信受信
    socket.on('chat_broadcast', async (data) => {
        // 自分に関係のあるチャットかつ、現在開いている相手からのメッセージなら画面に追加
        if (currentChatPartner && 
           ((data.sender === currentChatPartner && data.recipient === localStorage.getItem('session_email')) ||
            (data.sender === localStorage.getItem('session_email') && data.recipient === currentChatPartner))) {
            await appendSingleMessage(data.text, data.sender);
        }
    });

    // 誰かが鍵を送ったり承認したりしたら、お互いにお知らせやお友達リストを自動更新する
    socket.on('key_event_broadcast', async () => {
        await loadFriends();
        await checkNotifications();

        // いま開いているチャット相手が、更新後のお友達リスト(activeFriends)にまだ存在するかチェック
        if (currentChatPartner) {
            const isStillFriend = activeFriends.some(f => f.email === currentChatPartner);
            
            // もしリストから消えていたら（＝相手から削除されていたら）、即座に画面をロックして初期化
            if (!isStillFriend) {
                currentChatPartner = null;
                currentSessionKey = null;
                document.getElementById('chat-with-title').innerText = "👈 左のメニューからお相手を選択してください";
                document.getElementById('message-input').disabled = true;
                document.getElementById('send-btn').disabled = true;
                document.getElementById('message-input').placeholder = "相手を選択するとチャットが有効になります...";
                document.getElementById('chat-log').innerHTML = '';
                alert("このユーザーとの接続（カギ）が切断されました。");
            }
        }
    });
    // 初期データ読み込み
    await getMyOnetimeId();
    await loadFriends();
    await checkNotifications();

    // 3分ごとに自分のワンタイムIDを自動で更新する
    setInterval(getMyOnetimeId, 3 * 60 * 1000);
};

// 自分のワンタイムIDを取得
async function getMyOnetimeId() {
    const res = await fetch('/api/onetime-id', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ myEmail: localStorage.getItem('session_email') })
    });
    const data = await res.json();
    document.getElementById('my-onetime-id').innerText = data.code;

    // タイマー5分
    let timeLeft = 300; 

    // すでに古いタイマーが動いていたら一度止める（二重起動防止）
    if (idTimerInterval) clearInterval(idTimerInterval);

    const timerSpan = document.getElementById('id-timer');

    idTimerInterval = setInterval(() => {
        timeLeft--;

        // 分と秒を計算して「00:00」の形式にする
        const minutes = String(Math.floor(timeLeft / 60)).padStart(2, '0');
        const seconds = String(timeLeft % 60).padStart(2, '0');
        timerSpan.innerText = `${minutes}:${seconds}`;

        // 0秒になったらタイマーを止めて、新しいIDを再取得する
        if (timeLeft <= 0) {
            clearInterval(idTimerInterval);
            timerSpan.innerText = "更新中...";
            getMyOnetimeId(); // 新しいIDを取得
        }
    }, 1000); // 1秒（1000ミリ秒）ごとに実行
}

// 相手のワンタイムIDを検索
async function searchUser() {
    const code = document.getElementById('search-id-input').value.trim();
    if(!code) return;
    const panel = document.getElementById('search-result-panel');
    panel.style.display = 'none';

    const res = await fetch('/api/search-user', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ code })
    });
    if(res.ok) {
        const data = await res.json();
        if(data.email === localStorage.getItem('session_email')) {
            alert("自分自身は検索できません。"); return;
        }
        document.getElementById('target-user-email').innerText = data.email;
        panel.style.display = 'flex';
    } else {
        alert("有効なユーザーが見つかりませんでした。");
    }
}

// 2人だけの暗号鍵（セッション鍵）を生成して相手に送信
async function sendKeyExchange() {
    const receiver = document.getElementById('target-user-email').innerText;
    
    // その場限りの強固なランダムセッション鍵(256bit)を自動生成　(web crypto api)
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const hexKey = Array.from(rawKey).map(b => b.toString(16).padStart(2, '0')).join('');

    // 部屋のパスワードハッシュを使って、この鍵データ自体も暗号化してサーバー経由で送る
    const myHash = localStorage.getItem('session_hash');
    const encryptedHexKey = await encryptTextOnBrowser(hexKey, myHash);

    const res = await fetch('/api/send-key', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ sender: localStorage.getItem('session_email'), receiver, encryptedSessionKey: encryptedHexKey })
    });
    if(res.ok) {
        alert("相手にチャット暗号鍵を送信しました！相手が承認するとチャットが始まります。");
        document.getElementById('search-result-panel').style.display = 'none';
        document.getElementById('search-id-input').value = '';
        socket.emit('key_event_signal'); // WebSocketで通知
    }
}

// 自分宛ての鍵申請をチェック
async function checkNotifications() {
    const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ myEmail: localStorage.getItem('session_email') })
    });
    const data = await res.json();
    const area = document.getElementById('notification-area');
    if (data.notifications && data.notifications.length > 0) {
        currentPendingNotif = data.notifications[0];
        document.getElementById('notif-sender').innerText = currentPendingNotif.sender;
        area.style.display = 'block';
    } else {
        area.style.display = 'none';
        currentPendingNotif = null;
    }
}

// カギを受け取って承認
async function acceptKeyExchange() {
    if(!currentPendingNotif) return;
    const myHash = localStorage.getItem('session_hash');
    
    // 送られてきた暗号化された鍵を、自分の部屋ハッシュで復号（解読）
    const decryptedSessionKey = await decryptTextOnBrowser(currentPendingNotif.encrypted_session_key, myHash);

    const res = await fetch('/api/accept-key', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            notificationId: currentPendingNotif.id,
            myEmail: localStorage.getItem('session_email'),
            senderEmail: currentPendingNotif.sender,
            sessionKey: decryptedSessionKey
        })
    });
    if(res.ok) {
        alert("カギの交換が完了しました！リストから選択してチャットを始められます。");
        socket.emit('key_event_signal'); // リスト再読み込み
    }
}

//　届いたカギの申請を拒否する処理
async function rejectKeyExchange() {
    if(!currentPendingNotif) return;
    
    if(!confirm("このユーザーからの鍵交換の申請を拒否しますか？")) return;

    const res = await fetch('/api/reject-key', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            notificationId: currentPendingNotif.id
        })
    });
    
    if(res.ok) {
        alert("申請を拒否しました。");
        socket.emit('key_event_signal');
    }
}

// 鍵交換済みメニューの読み込み
async function loadFriends() {
    const res = await fetch('/api/friends', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ myEmail: localStorage.getItem('session_email') })
    });
    const data = await res.json();
    activeFriends = data.friends || [];

    const listDiv = document.getElementById('friend-list');
    listDiv.innerHTML = '';

    activeFriends.forEach(f => {
        const item = document.createElement('div');
        item.className = `friend-item ${currentChatPartner === f.email ? 'active' : ''}`;
        
        // ユーザー名を表示する
        const nameSpan = document.createElement('span');
        nameSpan.innerText = `👤 ${f.email}`;
        nameSpan.style.cursor = 'pointer';
        nameSpan.style.flex = '1';
        nameSpan.onclick = () => selectUserChat(f.email, f.key);
        item.appendChild(nameSpan);

        // ❌削除ボタンのパーツ
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-friend-btn';
        deleteBtn.innerText = '×';
        deleteBtn.title = 'このユーザーとの鍵を破棄して削除';

        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteFriend(f.email);
        };
        item.appendChild(deleteBtn);

        listDiv.appendChild(item);
    });
}

// 鍵の交換情報を削除する処理
async function deleteFriend(friendEmail) {
    if (!confirm(`「${friendEmail}」との鍵を破棄し、リストから削除しますか？\n（お互いにチャットが読めなくなります）`)) return;

    const myEmail = localStorage.getItem('session_email');

    const res = await fetch('/api/delete-friend', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ myEmail, friendEmail })
    });

    if (res.ok) {
        alert("削除が完了しました。");
        
        if (currentChatPartner === friendEmail) {
            currentChatPartner = null;
            currentSessionKey = null;
            document.getElementById('chat-with-title').innerText = " ←←メニューから連絡相手を選択";
            document.getElementById('message-input').disabled = true;
            document.getElementById('send-btn').disabled = true;
            document.getElementById('message-input').placeholder = "相手を選択するとチャットが有効になります";
            document.getElementById('chat-log').innerHTML = '';
        }

        socket.emit('key_event_signal'); // WebSocketで相手側の画面もリアルタイムに更新させる
    } else {
        alert("削除に失敗しました。");
    }
}

// チャット有効化
async function selectUserChat(email, hexKey) {
    currentChatPartner = email;
    currentSessionKey = hexKey;

    document.getElementById('chat-with-title').innerText = `💬 ${email} との暗号化通信`;
    
    document.getElementById('message-input').disabled = false;
    document.getElementById('send-btn').disabled = false;
    document.getElementById('message-input').placeholder = "このふたりだけの専用鍵で暗号化送信...";

    await loadFriends();

    await loadChatLog();
}


// チャット送受信
async function loadChatLog() {
    const chatLogDiv = document.getElementById('chat-log');
    chatLogDiv.innerHTML = '';
    const myEmail = localStorage.getItem('session_email');

    const response = await fetch('/api/chat');
    const data = await response.json();

    if (data.messages) {
        for (const msg of data.messages) {
            // 1対1メッセージをフィルタリング
            if ((msg.sender === myEmail && msg.recipient === currentChatPartner) ||
                (msg.sender === currentChatPartner && msg.recipient === myEmail)) {
                await appendSingleMessage(msg.text, msg.sender);
            }
        }
    }
}

async function appendSingleMessage(encryptedText, sender) {
    const chatLogDiv = document.getElementById('chat-log');
    const myEmail = localStorage.getItem('session_email');
    
    const decryptedText = await decryptTextOnBrowser(encryptedText, currentSessionKey);
    const isMe = (sender === myEmail);

    const itemDiv = document.createElement('div');
    itemDiv.className = `message-item ${isMe ? 'me' : 'other'}`;

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';
    bubbleDiv.innerText = decryptedText; 

    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.innerText = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

    itemDiv.appendChild(bubbleDiv);
    itemDiv.appendChild(timeDiv);
    chatLogDiv.appendChild(itemDiv);
    chatLogDiv.scrollTop = chatLogDiv.scrollHeight;
}

async function sendMessage() {
    const messageInput = document.getElementById('message-input');
    const text = messageInput.value.trim();
    if (!text || !currentChatPartner || !currentSessionKey) return;

    const encryptedText = await encryptTextOnBrowser(text, currentSessionKey);
    const myEmail = localStorage.getItem('session_email');

    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedText, sender: myEmail, recipient: currentChatPartner })
    });

    if (response.ok) {
        if (socket && socket.connected) {
            socket.emit('new_message_sent', { text: encryptedText, sender: myEmail, recipient: currentChatPartner });
        } else {
            await loadChatLog();
        }
        messageInput.value = '';
    }
}

function handleKeyPress(event) { if (event.key === 'Enter') sendMessage(); }


// 暗号化ヘルパー関数 (AES-GCM)
async function encryptTextOnBrowser(text, keyString) {
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const passwordBytes = encoder.encode(keyString);
    const digest = await crypto.subtle.digest('SHA-256', passwordBytes);
    const secretKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedBytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, secretKey, textBytes);
    const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
    const encryptedHex = Array.from(new Uint8Array(encryptedBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${ivHex}:${encryptedHex}`;
}

async function decryptTextOnBrowser(encryptedData, keyString) {
    const parts = encryptedData.split(':');
    if (parts.length !== 2) return "(解読不能な暗号データ)";
    const ivHex = parts[0];
    const encryptedHex = parts[1];
    const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const encryptedBytes = new Uint8Array(encryptedHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(keyString);
    const digest = await crypto.subtle.digest('SHA-256', passwordBytes);
    const secretKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
    try {
        const decryptedBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, secretKey, encryptedBytes);
        return new TextDecoder().decode(decryptedBytes);
    } catch (e) {
        return `🔒 [暗号化メッセージ] (あなた専用の暗号鍵では解読できません)`;
    }
}

function logout() {
    localStorage.clear(); alert("ログアウトしました。"); location.href = '/login.html';
}
