package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func items(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query("SELECT * FROM items WHERE owner = '" + r.URL.Query().Get("owner") + "'")
	_ = rows
}

func main() {
	http.HandleFunc("POST /items", items)
}
