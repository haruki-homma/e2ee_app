CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL
);

CREATE TABLE chat_messages (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    created_time TIMESTAMP DEFAULT NOW()
);

CREATE TABLE onetime_ids (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    code VARCHAR(10) NOT NULL,
    expires_at TIMESTAMP NOT NULL
);

CREATE TABLE key_exchanges (
    id SERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    receiver TEXT NOT NULL,
    encrypted_session_key TEXT NOT NULL,
    status TEXT DEFAULT 'pending'
);

CREATE TABLE connected_users (
    id SERIAL PRIMARY KEY,
    user1 TEXT NOT NULL,
    user2 TEXT NOT NULL,
    session_key TEXT NOT NULL,
    UNIQUE(user1, user2)
);