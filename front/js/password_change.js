window.onload = function() {
    if (!localStorage.getItem('session_email') || !localStorage.getItem('session_hash')) {
        alert("ログインが必要です。");
        location.href = '/login.html';
        return;
    }
    document.getElementById('email').value = localStorage.getItem('session_email');
};

// 鍵生成
async function hashPasswordOnBrowser(password, email) {
    const encoder = new TextEncoder();
    const secretData = encoder.encode(password + email); 
    const hashBuffer = await crypto.subtle.digest('SHA-256', secretData);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// AES-GCM 暗号化関数（メールアドレスの再暗号化用）
async function encryptTextOnBrowser(text, clientHashedPassword) {
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const passwordBytes = encoder.encode(clientHashedPassword);
    const digest = await crypto.subtle.digest('SHA-256', passwordBytes);
    const secretKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedBytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, secretKey, textBytes);

    const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
    const encryptedHex = Array.from(new Uint8Array(encryptedBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${ivHex}:${encryptedHex}`;
}

async function changePassword() {
    const email = document.getElementById('email').value;
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const messageDiv = document.getElementById('message');

    if (!email || !currentPassword || !newPassword) {
        messageDiv.style.color = 'red'; messageDiv.innerText = 'すべて入力してください。'; return;
    }

    messageDiv.style.color = 'orange'; messageDiv.innerText = '変更処理中...';
    
    // 古い鍵と新しい鍵を計算
    const oldClientHash = await hashPasswordOnBrowser(currentPassword, email);
    const newClientHash = await hashPasswordOnBrowser(newPassword, email);

    // 新しい鍵を使って、メールアドレスを新しく暗号化し直す
    const newEncryptedEmail = await encryptTextOnBrowser(email, newClientHash);

    try {
        const response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email, 
                oldClientHashedPassword: oldClientHash, 
                newClientHashedPassword: newClientHash,
                newEncryptedEmail: newEncryptedEmail 
            })
        });

        const data = await response.json();

        if (response.ok) {
            messageDiv.style.color = 'green';
            messageDiv.innerText = 'パスワードを変更しました。再ログインしてください。';
            
            localStorage.removeItem('session_email');
            localStorage.removeItem('session_hash');
            setTimeout(() => { location.href = '/login.html'; }, 2000);
        } else {
            messageDiv.style.color = 'red'; messageDiv.innerText = data.error;
        }
    } catch (e) {
        console.error(e);
        messageDiv.style.color = 'red'; messageDiv.innerText = 'エラーが発生しました。';
    }
}