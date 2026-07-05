# ガバショ！ PoC本番化ガイド（バックエンド＋実AI）

GitHub Pages版は**静的（standalone・localStorage）**で、コーチとメンバーは同じブラウザ内でのロール切替デモです。
実PoC（別々の人・端末、コーチが実際にメンバーの振り返りを受け取る）には **server.mjs をホストに常駐**させます。

## 1. サーバーを常駐（Render 例。fly.toml もあり Fly でも可）
1. このリポジトリを Render に接続（`render.yaml` 同梱）
2. 環境変数を設定：
   - `ANTHROPIC_API_KEY` … 実Claude生成に必須（未設定だと全AIはMOCK文面で動く）
   - `SESSION_SECRET` … `openssl rand -hex 24` の値（cookie署名）
   - `GABASHO_MODEL` … 省略時 `claude-opus-4-8`
   - `DEMO_PASSWORD` … 任意（初回に users.json を生成する共通パスワード）
3. デプロイ。`https://<your-app>.onrender.com` が本番URL（LP/アプリ/APIすべて server.mjs が配信）

> GitHub Pages（`shintaro1955-bot.github.io/gabasho-os/`）は今後も**営業デモ用の静的版**として併存可。実運用は常駐サーバー側URLを使う。

## 2. アカウント（users.json）
- 初回起動時、`users.json` が無ければ自動生成（`DEMO_PASSWORD` 共通）。
- 本番はメンバー／コーチ（アスリート・アナ）／管理者を実データで登録。各 `role`：member / coach / admin / operator。
- データは `data/<userId>.json`（メンバーごと）に保存。**Render等では永続ディスクを有効化**（無いと再起動で消える）。

## 3. すでにサーバー実装済み（curl検証済）
- 認証（scrypt＋HMAC署名cookie）、`/api/data` でメンバーのデータをサーバー保存
- `/api/coach/members` … コーチが担当メンバーの**最新ふりかえり(温度/人生観/次の一歩/ひとこと)・Zoom予約・プロフィール・承認状態**を取得
- `/api/coach/approve` … コーチが承認 → 本人の `approvedCount` に反映（別アカウント間で連携）
- `/api/ai`（kind=comment/personality/brief/video/encourage/milestones/**ownerReport/reflectInsight**）… キーがあれば実Claude、無ければMOCK

## 4. 残りの結線（クライアント側・SERVERモード）
サーバーは準備済み。クライアントを SERVER モードで下記に接続すると完全連動：
- コーチの「担当予定一覧」を `/api/coach/members`／承認を `/api/coach/approve` に（現在はブラウザ内モジュール配列）
- オーナー週次レポート文面・コーチ声かけを `aiCall('ownerReport'|'reflectInsight')` に（フォールバックでMOCK/テンプレ）

## 5. Zoom / メール / CRM（外部連携・別途）
- **Zoom**：Server-to-Server OAuth アプリ（Account/Client ID・Secret）→ `/api/meeting` で `POST /users/me/meetings` 発行、`meeting.ended` webhook でふりかえり自動起動
- **週次メール**：Resend/SendGrid + cron（毎週 月 8:00）で ownerReport を送信
- **CRM**：kintone REST / Salesforce OAuth 等で商談・成約を定期取得 → `data/<id>.json` の goals に反映
