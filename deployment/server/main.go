package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultListenAddress  = ":3232"
	defaultMaxRequestSize = int64(8 << 20)
	defaultMaxTextSize    = 4 << 20
	defaultMaxThumbSize   = 2 << 20
	defaultMaxStoreSize   = int64(2 << 30)
	shareIDAlphabet       = "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
)

type publishedScript struct {
	ID                string          `json:"id,omitempty"`
	ShareID           string          `json:"shareId,omitempty"`
	Name              string          `json:"name"`
	Target            string          `json:"target"`
	TargetVersion     string          `json:"targetVersion"`
	Description       string          `json:"description,omitempty"`
	Editor            string          `json:"editor"`
	Header            string          `json:"header"`
	Text              string          `json:"text"`
	Meta              json.RawMessage `json:"meta,omitempty"`
	ThumbnailBuffer   string          `json:"thumbnailBuffer,omitempty"`
	ThumbnailMimeType string          `json:"thumbnailMimeType,omitempty"`
}

type storedScript struct {
	SchemaVersion int             `json:"schemaVersion"`
	ID            string          `json:"id"`
	CreatedAt     time.Time       `json:"createdAt"`
	Script        publishedScript `json:"script"`
}

type limiterEntry struct {
	Tokens float64
	Last   time.Time
}

type publishLimiter struct {
	mu      sync.Mutex
	entries map[string]limiterEntry
	burst   float64
	rate    float64
}

func newPublishLimiter(burst int, refillInterval time.Duration) *publishLimiter {
	return &publishLimiter{
		entries: make(map[string]limiterEntry),
		burst:   float64(burst),
		rate:    1 / refillInterval.Seconds(),
	}
}

func (l *publishLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry, ok := l.entries[key]
	if !ok {
		entry = limiterEntry{Tokens: l.burst, Last: now}
	}
	entry.Tokens += now.Sub(entry.Last).Seconds() * l.rate
	if entry.Tokens > l.burst {
		entry.Tokens = l.burst
	}
	entry.Last = now
	if entry.Tokens < 1 {
		l.entries[key] = entry
		return false
	}
	entry.Tokens--
	l.entries[key] = entry
	return true
}

type app struct {
	siteDir        string
	dataDir        string
	maxRequestSize int64
	maxStoreSize   int64
	storeMu        sync.Mutex
	storeSize      int64
	limiter        *publishLimiter
	now            func() time.Time
}

func main() {
	siteDir := getenv("SITE_DIR", "/site")
	dataDir := getenv("SHARE_DATA_DIR", "/var/lib/makecode-shares")
	listenAddress := getenv("LISTEN_ADDR", defaultListenAddress)
	maxStoreSize := getenvInt64("SHARE_MAX_STORAGE_BYTES", defaultMaxStoreSize)
	application, err := newApp(siteDir, dataDir, maxStoreSize)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           application,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	log.Printf("serving site=%s shares=%s stored_bytes=%d limit_bytes=%d on %s",
		siteDir, dataDir, application.storeSize, maxStoreSize, listenAddress)
	log.Fatal(server.ListenAndServe())
}

func newApp(siteDir, dataDir string, maxStoreSize int64) (*app, error) {
	if maxStoreSize <= 0 {
		return nil, errors.New("share storage limit must be positive")
	}
	if info, err := os.Stat(siteDir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("site directory is unavailable: %s", siteDir)
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create share directory: %w", err)
	}
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return nil, fmt.Errorf("read share directory: %w", err)
	}
	var size int64
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".json") {
			info, statErr := entry.Info()
			if statErr != nil {
				return nil, fmt.Errorf("inspect share record: %w", statErr)
			}
			size += info.Size()
		}
	}
	return &app{
		siteDir:        siteDir,
		dataDir:        dataDir,
		maxRequestSize: defaultMaxRequestSize,
		maxStoreSize:   maxStoreSize,
		storeSize:      size,
		limiter:        newPublishLimiter(6, 10*time.Second),
		now:            time.Now,
	}, nil
}

func (a *app) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Permissions-Policy", "usb=(self)")
	response.Header().Set("X-Robots-Tag", "noindex, nofollow")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Referrer-Policy", "same-origin")
	if strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/api" {
		a.serveAPI(response, request)
		return
	}
	if a.serveShareLink(response, request) {
		return
	}
	a.serveStatic(response, request)
}

func (a *app) serveShareLink(response http.ResponseWriter, request *http.Request) bool {
	id := strings.TrimPrefix(request.URL.Path, "/")
	if strings.Contains(id, "/") || !validShareID(id) {
		return false
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return true
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, id+".json")); err != nil {
		http.NotFound(response, request)
		return true
	}
	response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.Redirect(response, request, "/#pub:"+id, http.StatusFound)
	return true
}

func (a *app) serveAPI(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if request.URL.Path == "/api/scripts" {
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeAPIError(response, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		a.publish(response, request)
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, "/api/"), "/")
	if len(parts) < 1 || len(parts) > 2 || !validShareID(parts[0]) ||
		(request.Method != http.MethodGet && request.Method != http.MethodHead) {
		writeAPIError(response, http.StatusNotFound, "share not found")
		return
	}
	a.readShare(response, request, parts)
}

func (a *app) publish(response http.ResponseWriter, request *http.Request) {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		writeAPIError(response, http.StatusUnsupportedMediaType, "content type must be application/json")
		return
	}
	client := clientAddress(request)
	if !a.limiter.allow(client, a.now()) {
		response.Header().Set("Retry-After", "10")
		writeAPIError(response, http.StatusTooManyRequests, "publishing rate limit exceeded")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, a.maxRequestSize)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var script publishedScript
	if err := decoder.Decode(&script); err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid project payload")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid trailing project data")
		return
	}
	if err := validateScript(&script); err != nil {
		writeAPIError(response, http.StatusBadRequest, err.Error())
		return
	}

	record := storedScript{SchemaVersion: 1, CreatedAt: a.now().UTC(), Script: script}
	encoded, err := json.Marshal(record)
	if err != nil {
		writeAPIError(response, http.StatusInternalServerError, "could not encode project")
		return
	}
	encoded = append(encoded, '\n')

	a.storeMu.Lock()
	defer a.storeMu.Unlock()
	for attempts := 0; attempts < 10; attempts++ {
		id, idErr := newShareID()
		if idErr != nil {
			writeAPIError(response, http.StatusInternalServerError, "could not allocate share id")
			return
		}
		record.ID = id
		encoded, err = json.Marshal(record)
		if err != nil {
			writeAPIError(response, http.StatusInternalServerError, "could not encode project")
			return
		}
		encoded = append(encoded, '\n')
		if a.storeSize+int64(len(encoded)) > a.maxStoreSize {
			writeAPIError(response, http.StatusInsufficientStorage, "share storage quota is full")
			return
		}
		filename := filepath.Join(a.dataDir, id+".json")
		file, openErr := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(openErr, os.ErrExist) {
			continue
		}
		if openErr != nil {
			writeAPIError(response, http.StatusInternalServerError, "could not store project")
			return
		}
		writeErr := func() error {
			if _, err := file.Write(encoded); err != nil {
				return err
			}
			return file.Sync()
		}()
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(filename)
			writeAPIError(response, http.StatusInternalServerError, "could not store project")
			return
		}
		if directory, dirErr := os.Open(a.dataDir); dirErr == nil {
			_ = directory.Sync()
			_ = directory.Close()
		}
		a.storeSize += int64(len(encoded))
		log.Printf("published id=%s bytes=%d client=%s", id, len(encoded), client)
		writeJSON(response, http.StatusOK, map[string]any{
			"id": id, "shortid": id, "meta": script.Meta,
		})
		return
	}
	writeAPIError(response, http.StatusInternalServerError, "could not allocate share id")
}

func (a *app) readShare(response http.ResponseWriter, request *http.Request, parts []string) {
	id := parts[0]
	data, err := os.ReadFile(filepath.Join(a.dataDir, id+".json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeAPIError(response, http.StatusNotFound, "share not found")
		} else {
			writeAPIError(response, http.StatusInternalServerError, "could not read share")
		}
		return
	}
	var record storedScript
	if err := json.Unmarshal(data, &record); err != nil || record.ID != id || record.SchemaVersion != 1 {
		writeAPIError(response, http.StatusInternalServerError, "share record is invalid")
		return
	}
	response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if len(parts) == 1 {
		writeJSON(response, http.StatusOK, map[string]any{
			"id":            record.ID,
			"name":          record.Script.Name,
			"target":        record.Script.Target,
			"targetVersion": record.Script.TargetVersion,
			"description":   record.Script.Description,
			"editor":        record.Script.Editor,
			"meta":          record.Script.Meta,
		})
		return
	}
	switch parts[1] {
	case "text":
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		response.WriteHeader(http.StatusOK)
		if request.Method != http.MethodHead {
			_, _ = io.WriteString(response, record.Script.Text)
		}
	case "thumb":
		if record.Script.ThumbnailBuffer == "" {
			writeAPIError(response, http.StatusNotFound, "thumbnail not found")
			return
		}
		thumbnail, decodeErr := base64.StdEncoding.DecodeString(record.Script.ThumbnailBuffer)
		if decodeErr != nil {
			writeAPIError(response, http.StatusInternalServerError, "thumbnail is invalid")
			return
		}
		response.Header().Set("Content-Type", record.Script.ThumbnailMimeType)
		response.Header().Set("Content-Length", strconv.Itoa(len(thumbnail)))
		response.WriteHeader(http.StatusOK)
		if request.Method != http.MethodHead {
			_, _ = response.Write(thumbnail)
		}
	default:
		writeAPIError(response, http.StatusNotFound, "share not found")
	}
}

func validateScript(script *publishedScript) error {
	if len(strings.TrimSpace(script.Name)) == 0 || len(script.Name) > 256 {
		return errors.New("project name is required and must be at most 256 characters")
	}
	if script.Target != "circuitplayground" {
		return errors.New("project target is not supported")
	}
	if script.TargetVersion == "" || len(script.TargetVersion) > 64 {
		return errors.New("project target version is invalid")
	}
	switch script.Editor {
	case "blocksprj", "tsprj", "pyprj":
	default:
		return errors.New("project editor is not supported")
	}
	if len(script.Header) == 0 || len(script.Header) > 1<<20 || !json.Valid([]byte(script.Header)) {
		return errors.New("project header is invalid")
	}
	if len(script.Text) == 0 || len(script.Text) > defaultMaxTextSize || !json.Valid([]byte(script.Text)) {
		return errors.New("project text is invalid")
	}
	var files map[string]string
	if err := json.Unmarshal([]byte(script.Text), &files); err != nil || files["pxt.json"] == "" {
		return errors.New("project text does not contain pxt.json")
	}
	if len(script.Meta) == 0 {
		script.Meta = json.RawMessage("{}")
	}
	if !json.Valid(script.Meta) {
		return errors.New("project metadata is invalid")
	}
	if script.ThumbnailBuffer != "" {
		if script.ThumbnailMimeType != "image/png" && script.ThumbnailMimeType != "image/gif" {
			return errors.New("project thumbnail type is not supported")
		}
		thumbnail, err := base64.StdEncoding.DecodeString(script.ThumbnailBuffer)
		if err != nil || len(thumbnail) > defaultMaxThumbSize {
			return errors.New("project thumbnail is invalid or too large")
		}
	} else if script.ThumbnailMimeType != "" {
		return errors.New("project thumbnail data is missing")
	}
	return nil
}

func (a *app) serveStatic(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	response.Header().Set("Cache-Control", "no-cache")
	requested := request.URL.Path
	if strings.Contains(requested, "\\") || strings.Contains(requested, "\x00") {
		http.NotFound(response, request)
		return
	}
	var candidates []string
	trimmed := strings.TrimPrefix(requested, "/")
	if strings.HasPrefix(requested, "/static/") {
		trimmedStatic := strings.TrimPrefix(requested, "/static/")
		candidates = []string{filepath.Join("docs", "static", filepath.FromSlash(trimmedStatic))}
	} else if strings.HasPrefix(requested, "/docs/") {
		name := strings.TrimPrefix(requested, "/")
		candidates = []string{name + ".html", name, filepath.Join(name, "index.html")}
	} else {
		if trimmed == "" {
			trimmed = "index.html"
		}
		candidates = []string{
			trimmed,
			trimmed + ".html",
			filepath.Join("docs", trimmed+".html"),
			filepath.Join(trimmed, "index.html"),
		}
	}
	for _, candidate := range candidates {
		filename, ok := a.safeSiteFile(candidate)
		if !ok {
			continue
		}
		if info, err := os.Stat(filename); err == nil && info.Mode().IsRegular() {
			serveFile(response, request, filename, info)
			return
		}
	}
	if strings.HasPrefix(requested, "/static/") ||
		strings.HasPrefix(requested, "/hexcache/") || filepath.Ext(requested) != "" {
		http.NotFound(response, request)
		return
	}
	filename := filepath.Join(a.siteDir, "index.html")
	info, err := os.Stat(filename)
	if err != nil {
		http.Error(response, "editor shell unavailable", http.StatusInternalServerError)
		return
	}
	serveFile(response, request, filename, info)
}

func (a *app) safeSiteFile(relative string) (string, bool) {
	clean := filepath.Clean(filepath.FromSlash(relative))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filepath.Join(a.siteDir, clean), true
}

func serveFile(response http.ResponseWriter, request *http.Request, filename string, info os.FileInfo) {
	if contentType := mime.TypeByExtension(filepath.Ext(filename)); contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	file, err := os.Open(filename)
	if err != nil {
		http.NotFound(response, request)
		return
	}
	defer file.Close()
	http.ServeContent(response, request, info.Name(), info.ModTime(), file)
}

func clientAddress(request *http.Request) string {
	if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
		if first := strings.TrimSpace(strings.Split(forwarded, ",")[0]); net.ParseIP(first) != nil {
			return first
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err == nil {
		return host
	}
	return request.RemoteAddr
}

func newShareID() (string, error) {
	id := make([]byte, 12)
	random := make([]byte, 32)
	for index := 0; index < len(id); {
		if _, err := rand.Read(random); err != nil {
			return "", err
		}
		for _, value := range random {
			// Discard the biased tail before reducing into the 58-character alphabet.
			if int(value) >= 256-256%len(shareIDAlphabet) {
				continue
			}
			id[index] = shareIDAlphabet[int(value)%len(shareIDAlphabet)]
			index++
			if index == len(id) {
				break
			}
		}
	}
	return "_" + string(id), nil
}

func validShareID(id string) bool {
	if len(id) != 13 || id[0] != '_' {
		return false
	}
	for _, character := range id[1:] {
		if !strings.ContainsRune(shareIDAlphabet, character) {
			return false
		}
	}
	return true
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else {
		return err
	}
}

func writeAPIError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"message": message})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func getenv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func getenvInt64(name string, fallback int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return parsed
}
