package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	// デフォルトポートを8080に設定し、環境変数PORTがあればそれを使用
	port := "8080"
	if fromEnv := os.Getenv("PORT"); fromEnv != "" {
		port = fromEnv
	}


	// ハンドラー関数を定義
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello, ECS! サーバーが正常に動作しています。いえい４回目だよ🧸")
	})

	// ヘルスチェック用エンドポイント
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Healthy")
	})

	// サーバー開始ログ
	log.Printf("サーバーがポート %s で起動しました...\n", port)

	// HTTPサーバーを起動
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
