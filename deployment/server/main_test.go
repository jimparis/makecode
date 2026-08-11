package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	root := t.TempDir()
	site := filepath.Join(root, "site")
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(site, "docs", "static"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"index.html":            "editor shell",
		"docs/boards.html":      "<h1>Boards</h1>",
		"docs/static/board.jpg": "jpeg",
	} {
		filename := filepath.Join(site, name)
		if err := os.MkdirAll(filepath.Dir(filename), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	application, err := newApp(site, data, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	application.now = func() time.Time { return time.Unix(1234, 0) }
	return application
}

func validPayload() []byte {
	pxtConfig, _ := json.Marshal(`{"name":"Share test","dependencies":{}}`)
	text := `{"pxt.json":` + string(pxtConfig) + `,"main.ts":"light.setAll(1)"}`
	value := publishedScript{
		Name: "Share test", Target: "circuitplayground", TargetVersion: "0.15.77",
		Editor: "blocksprj", Header: `{"name":"Share test","target":"circuitplayground"}`,
		Text: text,
		Meta: json.RawMessage(`{"versions":{"target":"0.15.77"}}`),
	}
	data, _ := json.Marshal(value)
	return data
}

func request(t *testing.T, application http.Handler, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	application.ServeHTTP(recorder, req)
	return recorder
}

func TestPublishAndReadImmutableShare(t *testing.T) {
	application := testApp(t)
	published := request(t, application, http.MethodPost, "/api/scripts", validPayload())
	if published.Code != http.StatusOK {
		t.Fatalf("publish status %d: %s", published.Code, published.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(published.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	id, _ := result["id"].(string)
	if !validShareID(id) || result["shortid"] != id {
		t.Fatalf("invalid publish response: %v", result)
	}
	shareLink := request(t, application, http.MethodGet, "/"+id, nil)
	if shareLink.Code != http.StatusFound || shareLink.Header().Get("Location") != "/#pub:"+id {
		t.Fatalf("share link status %d location %q", shareLink.Code, shareLink.Header().Get("Location"))
	}

	metadata := request(t, application, http.MethodGet, "/api/"+id, nil)
	if metadata.Code != http.StatusOK || !strings.Contains(metadata.Body.String(), `"target":"circuitplayground"`) {
		t.Fatalf("metadata status %d: %s", metadata.Code, metadata.Body.String())
	}
	text := request(t, application, http.MethodGet, "/api/"+id+"/text", nil)
	var payload publishedScript
	if err := json.Unmarshal(validPayload(), &payload); err != nil {
		t.Fatal(err)
	}
	if text.Code != http.StatusOK || text.Body.String() != payload.Text {
		t.Fatalf("text status %d: %s", text.Code, text.Body.String())
	}
	if cache := text.Header().Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Fatalf("share response is not immutable: %s", cache)
	}
	second := request(t, application, http.MethodPost, "/api/scripts", validPayload())
	if second.Code != http.StatusOK || second.Body.String() == published.Body.String() {
		t.Fatalf("shares did not receive distinct IDs: %s / %s", published.Body, second.Body)
	}
}

func TestRejectsInvalidPublishes(t *testing.T) {
	application := testApp(t)
	tests := []struct {
		name        string
		contentType string
		body        []byte
		status      int
	}{
		{"wrong content type", "text/plain", validPayload(), http.StatusUnsupportedMediaType},
		{"malformed json", "application/json", []byte(`{"name":`), http.StatusBadRequest},
		{"unknown field", "application/json", append(validPayload()[:len(validPayload())-1], []byte(`,"unknown":true}`)...), http.StatusBadRequest},
		{"wrong target", "application/json", bytes.Replace(validPayload(), []byte("circuitplayground"), []byte("maker"), 1), http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/scripts", bytes.NewReader(test.body))
			req.Header.Set("Content-Type", test.contentType)
			recorder := httptest.NewRecorder()
			application.ServeHTTP(recorder, req)
			if recorder.Code != test.status {
				t.Fatalf("got %d (%s), want %d", recorder.Code, recorder.Body, test.status)
			}
		})
	}
}

func TestStaticRoutesAndHeaders(t *testing.T) {
	application := testApp(t)
	for path, expected := range map[string]string{
		"/": "editor shell", "/boards": "<h1>Boards</h1>",
		"/static/board.jpg": "jpeg",
	} {
		response := request(t, application, http.MethodGet, path, nil)
		body, _ := io.ReadAll(response.Result().Body)
		if response.Code != http.StatusOK || string(body) != expected {
			t.Fatalf("%s: status %d body %q", path, response.Code, body)
		}
		if response.Header().Get("Permissions-Policy") != "usb=(self)" {
			t.Fatalf("%s lacks permissions policy", path)
		}
	}
	missing := request(t, application, http.MethodGet, "/static/missing.png", nil)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing static status %d", missing.Code)
	}
	missingFirmware := request(t, application, http.MethodGet,
		"/hexcache/7189a7a6e36e83b8f9c1d8a6bd09e8b0ff6cf19623de607753b3357dd232845e.hex", nil)
	if missingFirmware.Code != http.StatusNotFound || strings.Contains(missingFirmware.Body.String(), "editor shell") {
		t.Fatalf("missing firmware status %d body %q", missingFirmware.Code, missingFirmware.Body.String())
	}
	missingScript := request(t, application, http.MethodGet, "/missing-worker.js", nil)
	if missingScript.Code != http.StatusNotFound || strings.Contains(missingScript.Body.String(), "editor shell") {
		t.Fatalf("missing script status %d body %q", missingScript.Code, missingScript.Body.String())
	}
	missingShare := request(t, application, http.MethodGet, "/_23456789abcd", nil)
	if missingShare.Code != http.StatusNotFound {
		t.Fatalf("missing share status %d", missingShare.Code)
	}
}

func TestRateAndStorageLimits(t *testing.T) {
	application := testApp(t)
	application.limiter = newPublishLimiter(1, time.Hour)
	first := request(t, application, http.MethodPost, "/api/scripts", validPayload())
	second := request(t, application, http.MethodPost, "/api/scripts", validPayload())
	if first.Code != http.StatusOK || second.Code != http.StatusTooManyRequests {
		t.Fatalf("rate statuses %d, %d", first.Code, second.Code)
	}
	application = testApp(t)
	application.maxStoreSize = 1
	full := request(t, application, http.MethodPost, "/api/scripts", validPayload())
	if full.Code != http.StatusInsufficientStorage {
		t.Fatalf("storage status %d: %s", full.Code, full.Body)
	}
}
