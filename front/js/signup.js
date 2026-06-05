// パスワードのハッシュ化（ブラウザ側で処理）、秘密鍵のもとになる文字列を生成（2回ハッシュしたものを鍵にする）
async function hashPasswordOnBrowser(password, email) {
    const encoder = new TextEncoder(); //バイナリ化のエンコーダ
    // レインボーテーブル対策
    // パスワードとメールアドレスでハッシュ化、メールをソルト
    // サーバ側での漏洩リスクを減らす
    const secretData = encoder.encode(password + email); // バイナリ化
    const hashBuffer = await crypto.subtle.digest('SHA-256', secretData); // ハッシュ化
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');  // ハッシュの16進数表現を返す
}

// メールアドレスを暗号化（ブラウザ側で処理）
async function encryptEmailOnBrowser(email, clientHashedPassword) {
    const encoder = new TextEncoder(); // バイナリ化エンコーダ
    const passwordBytes = encoder.encode(clientHashedPassword); // ハッシュ化されたパスワードをバイナリ化
    const digest = await crypto.subtle.digest('SHA-256', passwordBytes); // ハッシュ化されたパスワードをさらにハッシュ化して鍵を生成
    const secretKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']); // AES-GCMの共通鍵

    const iv = crypto.getRandomValues(new Uint8Array(12)); //IVはランダムに生成（12バイト）
    // 同じメールアドレスを登録しても、毎回変わる暗号文結果になる
    const encryptedBytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, secretKey, encoder.encode(email)); // バイナリ化

    const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join(''); // IVを16進数表現にする
    const encryptedHex = Array.from(new Uint8Array(encryptedBytes)).map(b => b.toString(16).padStart(2, '0')).join(''); //　暗号化されたメールアドレスも16進数表現にする
    return `${ivHex}:${encryptedHex}`; // 「ランダムな値:暗号化したメールアドレス」
}

// 新規登録の処理
async function submitSignup() {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const messageDiv = document.getElementById('message');

    if (!email || !password) { messageDiv.style.color = 'red'; messageDiv.innerText = 'すべて入力してください。'; return; } // 入力なかったらエラー表示

    try {
        messageDiv.style.color = 'orange'; messageDiv.innerText = '処理中...'; // 処理中の表示

        // 生パスワードをブラウザ側でハッシュ化
        const clientHashedPassword = await hashPasswordOnBrowser(password, email);

        // ハッシュ化されたパスワードを鍵にして、メールアドレスを暗号化
        const encryptedEmail = await encryptEmailOnBrowser(email, clientHashedPassword);

        // ハッシュ化された文字列を送信
        const response = await fetch('/api/signup', {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                encryptedEmail: encryptedEmail, 
                clientHashedPassword: clientHashedPassword 
            })
        });

        const data = await response.json();
        if (response.ok) { // 登録成功
            messageDiv.style.color = 'green'; messageDiv.innerText = '登録完了。ログイン画面へ移動';
            setTimeout(() => { window.location.href = '/login.html'; }, 2000);　// timerなくていい
        } else { // 登録済みのエラー表示
            messageDiv.style.color = 'red'; messageDiv.innerText = data.error || 'エラー発生';
        }
    } catch (e) { // 通信エラーの表示
        messageDiv.style.color = 'red'; messageDiv.innerText = 'エラー発生';
    }
}