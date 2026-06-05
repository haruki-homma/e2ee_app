window.onload = function() {
    // すでにログイン済みである場合、自動的にチャット画面へリダイレクト
    if (localStorage.getItem('session_email') && localStorage.getItem('session_hash')) {
        location.href = '/chat.html';
    }
};

// 鍵生成 signup.htmlのものと同じ
async function hashPasswordOnBrowser(password, email) {
    const encoder = new TextEncoder();
    const secretData = encoder.encode(password + email); 
    const hashBuffer = await crypto.subtle.digest('SHA-256', secretData);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 復号
async function decryptTextOnBrowser(encryptedData, clientHashedPassword) {
    try {
        const [ivHex, encryptedHex] = encryptedData.split(':');
        const iv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const encryptedBytes = new Uint8Array(encryptedHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        const encoder = new TextEncoder();
        const passwordBytes = encoder.encode(clientHashedPassword);
        const digest = await crypto.subtle.digest('SHA-256', passwordBytes);
        const secretKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);

        const decryptedBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, secretKey, encryptedBytes);
        return new TextDecoder().decode(decryptedBytes);
    } catch (e) {
        return '[復号失敗]'; 
    }
}

async function submitLogin() {
    const inputEmail = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const messageDiv = document.getElementById('message');

    if (!inputEmail || !password) { messageDiv.style.color = 'red'; messageDiv.innerText = 'すべて入力してください。'; return; }
    messageDiv.style.color = 'orange'; messageDiv.innerText = '認証中...';

    const clientHashedPassword = await hashPasswordOnBrowser(password, inputEmail);

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientHashedPassword })
        });

        const data = await response.json();
        if (!response.ok) { messageDiv.style.color = 'red'; messageDiv.innerText = data.error; return; }

        let loginSuccess = false;
        for (const user of data.users) {
            const decryptedEmail = await decryptTextOnBrowser(user.email, clientHashedPassword);
            if (decryptedEmail === inputEmail) { loginSuccess = true; break; }
        }

        if (loginSuccess) {
            localStorage.setItem('session_email', inputEmail);
            localStorage.setItem('session_hash', clientHashedPassword);
            location.href = '/chat.html';
        } else {
            messageDiv.style.color = 'red'; messageDiv.innerText = 'メールアドレスまたはパスワードが違います。';
        }
    } catch (e) {
        messageDiv.style.color = 'red'; messageDiv.innerText = 'エラー発生';
    }
}