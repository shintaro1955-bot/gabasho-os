# ガバショ！OS — どこでも動く本番イメージ（ゼロ依存・npm install不要）
FROM node:20-alpine
WORKDIR /app
COPY . .
# データ保存先（永続ディスクをこのパスにマウントすると本番でも消えない）
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
