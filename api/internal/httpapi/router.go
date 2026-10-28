// Package httpapi is the HTTP surface: routing, auth, JSON encoding, and in a
// packaged build the React SPA served alongside it from the same binary.
package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/store"
)

type Server struct {
	store  *store.Store
	router *mux.Router
}

func New(st *store.Store, token string) *Server {
	s := &Server{store: st, router: mux.NewRouter()}

	// Unauthenticated: the container healthcheck must work without holding the
	// token, and it reveals nothing beyond whether the database answers.
	s.router.HandleFunc("/healthz", s.healthz).Methods(http.MethodGet)

	api := s.router.PathPrefix("/api/v1").Subrouter()
	api.Use(requireToken(token))

	api.HandleFunc("/checkpoints", s.postCheckpoint).Methods(http.MethodPost)
	api.HandleFunc("/checkpoints", s.listCheckpoints).Methods(http.MethodGet)
	api.HandleFunc("/checkpoints/{date}", s.getCheckpoint).Methods(http.MethodGet)

	api.HandleFunc("/wallet-accounts", s.listWalletAccounts).Methods(http.MethodGet)
	api.HandleFunc("/wallet-accounts/{id}", s.classifyWalletAccount).Methods(http.MethodPatch)

	api.HandleFunc("/settings", s.getSettings).Methods(http.MethodGet)
	api.HandleFunc("/settings/target-allocation", s.putTargetAllocation).Methods(http.MethodPut)

	api.HandleFunc("/networth", s.getNetworth).Methods(http.MethodGet)
	api.HandleFunc("/allocation", s.getAllocation).Methods(http.MethodGet)
	api.HandleFunc("/trades", s.postTrades).Methods(http.MethodPost)
	api.HandleFunc("/trades/{id}", s.deleteTrade).Methods(http.MethodDelete)
	api.HandleFunc("/realised", s.getRealised).Methods(http.MethodGet)
	api.HandleFunc("/disposals", s.getDisposals).Methods(http.MethodGet)
	api.HandleFunc("/compare", s.getCompare).Methods(http.MethodGet)
	api.HandleFunc("/prices", s.postPrices).Methods(http.MethodPost)
	api.HandleFunc("/prices/coverage", s.getPriceCoverage).Methods(http.MethodGet)
	api.HandleFunc("/orders", s.getOrders).Methods(http.MethodGet)
	api.HandleFunc("/orders", s.postOrders).Methods(http.MethodPost)
	api.HandleFunc("/orders/reconcile", s.getReconcile).Methods(http.MethodGet)
	api.HandleFunc("/us-cost-basis", s.getUSCostBasis).Methods(http.MethodGet)
	api.HandleFunc("/us-cost-basis", s.putUSCostBasis).Methods(http.MethodPut)
	api.HandleFunc("/price-targets", s.getPriceTargets).Methods(http.MethodGet)
	api.HandleFunc("/price-targets", s.putPriceTargets).Methods(http.MethodPut)
	api.HandleFunc("/price-targets/{sleeve}/{symbol}", s.deletePriceTarget).Methods(http.MethodDelete)

	api.HandleFunc("/sleeves", s.getSleeves).Methods(http.MethodGet)
	api.HandleFunc("/projection", s.getProjection).Methods(http.MethodGet)
	api.HandleFunc("/sleeves/{sleeve}/holdings", s.getSleeveHoldings).Methods(http.MethodGet)
	api.HandleFunc("/expenses", s.getExpenses).Methods(http.MethodGet)
	api.HandleFunc("/expenses/breakdown", s.getBreakdown).Methods(http.MethodGet)
	api.HandleFunc("/expenses/transactions", s.getExpenseTransactions).Methods(http.MethodGet)

	api.HandleFunc("/transactions", s.postTransactions).Methods(http.MethodPost)
	api.HandleFunc("/refresh-state", s.refreshState).Methods(http.MethodGet)

	api.HandleFunc("/fixed-deposits", s.listFixedDeposits).Methods(http.MethodGet)
	api.HandleFunc("/fixed-deposits", s.createFixedDeposit).Methods(http.MethodPost)
	api.HandleFunc("/fixed-deposits/{id}", s.updateFixedDeposit).Methods(http.MethodPut)
	api.HandleFunc("/fixed-deposits/{id}", s.deleteFixedDeposit).Methods(http.MethodDelete)

	api.HandleFunc("/splitwise", s.listSplitwise).Methods(http.MethodGet)
	api.HandleFunc("/splitwise/{person}", s.setSplitwise).Methods(http.MethodPut)
	api.HandleFunc("/splitwise/{person}", s.deleteSplitwise).Methods(http.MethodDelete)

	api.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "no such endpoint: "+r.Method+" "+r.URL.Path)
	})

	mountSPA(s.router)

	s.router.Use(logRequests)
	return s
}

func (s *Server) Handler() http.Handler { return s.router }

// nowUTC is the clock, in one place so tests and handlers agree on what
// "today" means for valuing an FD.
func nowUTC() time.Time { return time.Now().UTC() }

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db unreachable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// fail logs the real error and returns a generic one. Error text from a query
// can echo account names and amounts; the response is the one place that might
// leak somewhere less private than the log.
func (s *Server) fail(w http.ResponseWriter, what string, err error) {
	slog.Error(what, "err", err)
	writeError(w, http.StatusInternalServerError, what+" failed — see the server log")
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" && rec.status == http.StatusOK {
			return // the container probes this every 10s; do not drown the log
		}
		slog.Info("request",
			"method", r.Method, "path", r.URL.Path,
			"status", rec.status, "dur", time.Since(start).Round(time.Millisecond))
	})
}
