# ガバショ！ AIコーチングOS — 本番アプリ（ログイン付き）

APIキーを**サーバー側に隠した**まま、複数人で安全に使える実証実験用アプリ。
ゼロ依存（Node標準モジュールのみ）。`npm install` 不要。

```
gabasho-os-app/
├─ server.mjs        … APIプロキシ＋簡易ログイン＋データ保存（Node, 依存なし）
├─ public/index.html … SPA（ログイン→ロール別画面→AIコーチング）
├─ data/             … ユーザーごとの保存データ（自動生成・.gitignore）
├─ users.json        … アカウント（初回起動で自動生成・.gitignore）
├─ .env.example      … 設定見本（.env にコピー）
└─ package.json
```

## 使い方（最短）

```bash
cd gabasho-os-app
cp .env.example .env          # ANTHROPIC_API_KEY と SESSION_SECRET を設定
npm start                     # = node server.mjs
# → http://localhost:4200
```

- 初回起動時に `users.json` を生成し、ログイン用アカウントをコンソールに表示します
  （共通パスワードは `.env` の `DEMO_PASSWORD`、既定 `gabasho123`）。
  - `demo@gabasho.local`（メンバー）／`admin@gabasho.local`（会社管理者）
  - `coach@gabasho.local`（コーチ）／`ops@gabasho.local`（運営）
- `ANTHROPIC_API_KEY` 未設定でも起動でき、AIは**モック**で動きます（UIの確認用）。設定すると本物のClaudeで生成。

## 仕組み（安全設計）

- **APIキーはサーバーの環境変数のみ**。ブラウザには一切渡らない。AIは `POST /api/ai { kind, input }` 経由で、サーバーが kind ごとの system プロンプト＋JSONスキーマを付けて Anthropic を呼ぶ（クライアントは system を指定できない＝鍵の悪用を防止）。
- **ログイン**：scrypt でパスワードをハッシュ化、HMAC署名付き **httpOnly Cookie** でセッション維持。
- **データ**：ユーザーごとに `data/<id>.json` へサーバー保存（日記・気分・連続記録・目標・診断・動画）。
- **ロール**：アカウントの role（member/coach/admin/operator）で表示画面を固定（ロール切替UIはサーバーモードでは非表示）。

## 本番運用メモ
- `SESSION_SECRET` は必ずランダムな長い文字列に。HTTPSの背後（リバースプロキシ）で動かし、Cookieに `Secure` を付ける運用を推奨。
- アカウント追加は `users.json` を編集（パスワードは scrypt ハッシュ）か、必要なら登録APIを足す。
- データ層は現状ファイル。規模が出たら DB / kintone / Sheets に差し替え可（`/api/data` の読み書きを置換するだけ）。

## スタンドアロン版
`public/index.html` を単体でブラウザに開くと、サーバーなしの「ブラウザにキーを貼る」デモモードでも動作します（個人検証用）。社外配布はサーバー版を使ってください。
