const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); 
const io = new Server(server);         

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const frontPath = path.resolve(__dirname, '../front');
app.use(express.static(frontPath));

app.get('/', (req, res) => { res.sendFile(path.join(frontPath, 'login.html')); });
app.get('/chat', (req, res) => { res.sendFile(path.join(frontPath, 'chat.html')); });
app.get('/password', (req, res) => { res.sendFile(path.join(frontPath, 'password_change.html')); });

// WebSocket接続イベント
io.on('connection', (socket) => {
    io.emit('update_user_count', { count: io.engine.clientsCount });

    socket.on('new_message_sent', (data) => {
        // 1対1チャットのため、全員にばら撒いたあとフロント側で自分宛てか判定する
        io.emit('chat_broadcast', data);
    });

    // 鍵が送信されたり承認されたりしたことをリアルタイムに通知する合図
    socket.on('key_event_signal', () => {
        io.emit('key_event_broadcast');
    });

    socket.on('disconnect', () => {
        io.emit('update_user_count', { count: io.engine.clientsCount });
    });
});


// 認証系 API (ログイン・登録・パスワード変更)
app.post('/api/signup', async (req, res) => {
    try {
        const { encryptedEmail, clientHashedPassword } = req.body;
        const passwordHash = await bcrypt.hash(clientHashedPassword, 10);
        await pool.query('INSERT INTO users (email, pass) VALUES ($1, $2)', [encryptedEmail, passwordHash]);
        res.status(201).json({ message: 'ユーザー登録が完了しました！' });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'このメールアドレスは既に登録されています。' });
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { clientHashedPassword } = req.body;
        const result = await pool.query('SELECT email, pass FROM users');
        const matchedUsers = [];
        for (const row of result.rows) {
            if (await bcrypt.compare(clientHashedPassword, row.pass)) {
                matchedUsers.push({ email: row.email });
            }
        }
        if (matchedUsers.length === 0) return res.status(401).json({ error: 'ログイン失敗' });
        res.status(200).json({ users: matchedUsers });
    } catch (error) {
        res.status(500).json({ error: 'サーバーエラー' });
    }
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { email, oldClientHashedPassword, newClientHashedPassword, newEncryptedEmail } = req.body;
        const result = await pool.query('SELECT id, pass FROM users');
        let targetUserId = null;
        for (const row of result.rows) {
            if (await bcrypt.compare(oldClientHashedPassword, row.pass)) { targetUserId = row.id; break; }
        }
        if (!targetUserId) return res.status(401).json({ error: 'パスワードが正しくありません。' });
        const newPasswordHash = await bcrypt.hash(newClientHashedPassword, 10);
        await pool.query('UPDATE users SET pass = $1, email = $2 WHERE id = $3', [newPasswordHash, newEncryptedEmail, targetUserId]);
        res.status(200).json({ message: '正常更新' });
    } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});


// ワンタイムID ＆ 鍵交換 API
// 自分のワンタイムIDを取得・新規発行する（有効期限5分）
app.post('/api/onetime-id', async (req, res) => {
    const { myEmail } = req.body;
    try {
        // 古い期限切れのIDをこのタイミングで掃除
        await pool.query('DELETE FROM onetime_ids WHERE expires_at < NOW()');

        // すでに有効なIDがあればそれを返す
        const exist = await pool.query('SELECT code FROM onetime_ids WHERE email = $1', [myEmail]);
        if (exist.rows.length > 0) {
            return res.json({ code: exist.rows[0].code });
        }

        // なければランダムな6桁の数字を発行
        const newCode = String(crypto.randomInt(100000, 999999));
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5分後

        await pool.query('INSERT INTO onetime_ids (email, code, expires_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3', [myEmail, newCode, expiresAt]);
        res.json({ code: newCode });
    } catch (err) { console.error(err); res.status(500).end(); }
});

// ワンタイムIDから相手を検索する
app.post('/api/search-user', async (req, res) => {
    const { code } = req.body;
    try {
        await pool.query('DELETE FROM onetime_ids WHERE expires_at < NOW()');
        const result = await pool.query('SELECT email FROM onetime_ids WHERE code = $1', [code]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つからないか、IDの期限が切れています。' });
        res.json({ email: result.rows[0].email });
    } catch (err) { res.status(500).end(); }
});

// 相手に暗号鍵を送信する（申請）
app.post('/api/send-key', async (req, res) => {
    const { sender, receiver, encryptedSessionKey } = req.body;
    try {
        await pool.query('INSERT INTO key_exchanges (sender, receiver, encrypted_session_key) VALUES ($1, $2, $3)', [sender, receiver, encryptedSessionKey]);
        res.json({ success: true });
    } catch (err) { res.status(500).end(); }
});

// 自分宛てに届いている鍵の申請一覧を取得する
app.post('/api/notifications', async (req, res) => {
    const { myEmail } = req.body;
    try {
        const result = await pool.query("SELECT id, sender, encrypted_session_key FROM key_exchanges WHERE receiver = $1 AND status = 'pending'", [myEmail]);
        res.json({ notifications: result.rows });
    } catch (err) { res.status(500).end(); }
});

// 届いた鍵の申請を承認する
app.post('/api/accept-key', async (req, res) => {
    const { notificationId, myEmail, senderEmail, sessionKey } = req.body;
    try {
        // 接続完了テーブルに保存
        const u1 = myEmail < senderEmail ? myEmail : senderEmail;
        const u2 = myEmail < senderEmail ? senderEmail : myEmail;
        await pool.query('INSERT INTO connected_users (user1, user2, session_key) VALUES ($1, $2, $3) ON CONFLICT (user1, user2) DO UPDATE SET session_key = $3', [u1, u2, sessionKey]);
        
        // 申請ステータスを更新
        await pool.query("UPDATE key_exchanges SET status = 'accepted' WHERE id = $1", [notificationId]);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).end(); }
});

// 届いた鍵の申請を拒否する
app.post('/api/reject-key', async (req, res) => {
    const { notificationId } = req.body;
    try {
        // 申請データをデータベースから完全に削除する（またはstatus = 'rejected'にする）
        await pool.query('DELETE FROM key_exchanges WHERE id = $1', [notificationId]);
        res.json({ success: true });
    } catch (err) { 
        console.error(err); 
        res.status(500).end(); 
    }
});

// 鍵交換している連絡相手リストを取得する
app.post('/api/friends', async (req, res) => {
    const { myEmail } = req.body;
    try {
        const result = await pool.query('SELECT user1, user2, session_key FROM connected_users WHERE user1 = $1 OR user2 = $1', [myEmail]);
        const friends = result.rows.map(row => {
            const partner = (row.user1 === myEmail) ? row.user2 : row.user1;
            return { email: partner, key: row.session_key };
        });
        res.json({ friends });
    } catch (err) { res.status(500).end(); }
});

// 鍵を交換した連絡相手を削除する
app.post('/api/delete-friend', async (req, res) => {
    const { myEmail, friendEmail } = req.body;
    try {
        await pool.query(
            "DELETE FROM connected_users WHERE (user1 = $1 AND user2 = $2) OR (user1 = $2 AND user2 = $1)",
            [myEmail, friendEmail]
        );
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).end();
    }
});


// チャット管理 API
app.post('/api/chat', async (req, res) => {
    const { encryptedText, sender, recipient } = req.body;
    try {
        await pool.query('INSERT INTO chat_messages (text, sender, recipient) VALUES ($1, $2, $3)', [encryptedText, sender, recipient]);
        res.json({ success: true });
    } catch (err) { res.status(500).end(); }
});

app.get('/api/chat', async (req, res) => {
    try {
        // 全チャットログを返す
        const result = await pool.query('SELECT text, sender, recipient, created_time FROM chat_messages ORDER BY created_time ASC');
        res.json({ messages: result.rows });
    } catch (err) { res.status(500).end(); }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(` サーバ起動完了:http://localhost:${PORT} `);
    console.log(`==================================================`);
});