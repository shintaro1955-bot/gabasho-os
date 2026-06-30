# ガバショ！OS デプロイ手順（固定URL・常時稼働）

ゼロ依存のNodeサーバーなので、どのPaaSでも数分で上がります。**最短はRender（GitHub連携で数クリック）**。
本番では `ANTHROPIC_API_KEY`（実Claude）と `SESSION_SECRET`（長いランダム文字列）を必ず設定してください。

---

## A. Render（最短・GitHub連携） ※おすすめ
1. このフォルダをGitHubリポジトリにpush（下の「Gitに上げる」参照）
2. https://render.com → New + → **Blueprint** → 当該リポジトリを選択（`render.yaml` を自動検出）
3. Apply → デプロイ。発行URL `https://gabasho-os.onrender.com` で公開
4. Dashboard → Environment で **`ANTHROPIC_API_KEY`** を設定（未設定ならAIはモック動作）
- 無料プランは「アクセスが無いと休止→次アクセスで数十秒のコールドスタート」「ディスク揮発（再デプロイでデータ初期化）」。
- pilot/本番でデータを残すなら `render.yaml` の `disk:` のコメントを外し、Starter以上に。

## B. Fly.io（固定URL＋データ永続・東京リージョン）
```bash
brew install flyctl          # 未導入なら
fly auth login
fly launch --copy-config --no-deploy   # fly.toml を利用（app名は適宜変更）
fly volumes create gabasho_data --size 1 --region nrt
fly secrets set ANTHROPIC_API_KEY=sk-ant-xxxx SESSION_SECRET=$(openssl rand -hex 24) DEMO_PASSWORD=お好み
fly deploy
```
→ `https://<app>.fly.dev` で公開。`/app/data` がボリュームに保存され消えません。

## C. Railway
1. GitHubにpush → https://railway.app → New Project → Deploy from Repo
2. Variables に `ANTHROPIC_API_KEY` / `SESSION_SECRET` / `DEMO_PASSWORD` を設定
3. Settings → Networking → Generate Domain で公開URL発行
- 永続化は Volume を `/app/data` にマウント

## D. Docker（VPS等どこでも）
```bash
docker build -t gabasho-os .
docker run -d -p 80:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-xxxx \
  -e SESSION_SECRET=$(openssl rand -hex 24) \
  -e DEMO_PASSWORD=お好み \
  -v $PWD/data:/app/data \
  gabasho-os
```

---

## Gitに上げる（A/Cの前準備）
```bash
cd gabasho-os-app
git init && git add -A && git commit -m "gabasho-os: deployable"
# GitHubで空リポジトリを作成し:
git remote add origin https://github.com/<you>/gabasho-os.git
git branch -M main && git push -u origin main
```

## 環境変数まとめ
| 変数 | 用途 | 例 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 実Claude（未設定でモック動作） | `sk-ant-...` |
| `SESSION_SECRET` | ログインCookie署名（必須・長いランダム） | `openssl rand -hex 24` |
| `DEMO_PASSWORD` | 初回生成アカウント共通PW | `gabasho123`（本番は変更） |
| `GABASHO_MODEL` | 使用モデル | `claude-opus-4-8` |
| `PORT` | 待受ポート（PaaSが自動設定） | `8080` |

## デプロイ後の確認
- `https://<your-url>/` でログイン画面 → `staff1@gabasho.local` 等 / `DEMO_PASSWORD`
- 本番ではHTTPS（各PaaS標準）。`SESSION_SECRET` は必ず固有値に。
