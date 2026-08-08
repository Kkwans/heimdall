CREATE TABLE providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL
);

CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    model TEXT NOT NULL,
    status_code INTEGER DEFAULT 200
);

INSERT INTO providers (name, base_url, api_key)
VALUES ('fixture-provider', 'http://fake-upstream:8090', 'fixture-not-a-secret');

INSERT INTO requests (date, model, status_code)
VALUES ('2026-01-01', 'fixture-model', 200);
