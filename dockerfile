# ビルドステージ
FROM golang:1.23-alpine AS builder

WORKDIR /app

# 依存関係を先にコピーしてキャッシュを有効活用
COPY go.mod go.sum ./
RUN go mod download

# ソースコードをコピー
COPY . .

# ビルドオプションを明確に指定して静的リンクでビルド
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o main .

# 実行用ステージ (軽量イメージ)
FROM alpine:latest

# 必要最小限の依存関係をインストール
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# ビルドステージからバイナリをコピー
COPY --from=builder /app/main ./main

# 実行時に公開されるポートを指定
EXPOSE 8080

# コンテナの起動コマンドを設定
ENTRYPOINT ["/root/main"]
