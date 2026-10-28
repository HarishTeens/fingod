package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/harishteens/fingod/api/internal/compute"
	"github.com/harishteens/fingod/api/internal/domain"
	"github.com/harishteens/fingod/api/internal/store"
)

// fdView is an FD plus what it is worth today, since the stored row alone
// answers none of the questions anyone actually opens this screen to ask.
type fdView struct {
	domain.FixedDeposit
	Accrued         domain.Num `json:"accrued_interest"`
	Value           domain.Num `json:"value"`
	AccruedAt       string     `json:"accrued_as_of"`
	ValueAtMaturity domain.Num `json:"value_at_maturity"`
}

func (s *Server) listFixedDeposits(w http.ResponseWriter, r *http.Request) {
	at := domain.NewDate(nowUTC())
	if v := r.URL.Query().Get("at"); v != "" {
		d, err := domain.ParseDate(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		at = d
	}

	fds, err := s.store.FixedDeposits(r.Context(), r.URL.Query().Get("include_closed") == "true")
	if err != nil {
		s.fail(w, "list fixed deposits", err)
		return
	}

	views := make([]fdView, 0, len(fds))
	totalPrincipal, totalAccrued := "0.00", "0.00"
	for _, fd := range fds {
		v, err := fdViewOf(fd, at)
		if err != nil {
			s.fail(w, "value fixed deposit", err)
			return
		}
		views = append(views, *v)
		totalPrincipal = compute.AddMoney(totalPrincipal, fd.Principal)
		totalAccrued = compute.AddMoney(totalAccrued, v.Accrued)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"fixed_deposits":  views,
		"as_of":           at.String(),
		"total_principal": domain.Num(totalPrincipal),
		"total_accrued":   domain.Num(totalAccrued),
		"total_value":     domain.Num(compute.AddMoney(totalPrincipal, domain.Num(totalAccrued))),
	})
}

func (s *Server) createFixedDeposit(w http.ResponseWriter, r *http.Request) {
	fd, ok := decodeFD(w, r)
	if !ok {
		return
	}
	created, err := s.store.CreateFixedDeposit(r.Context(), fd)
	if err != nil {
		s.fail(w, "create fixed deposit", err)
		return
	}
	view, err := fdViewOf(*created, domain.NewDate(nowUTC()))
	if err != nil {
		s.fail(w, "value fixed deposit", err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) updateFixedDeposit(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id must be an integer")
		return
	}
	fd, ok := decodeFD(w, r)
	if !ok {
		return
	}
	updated, err := s.store.UpdateFixedDeposit(r.Context(), id, fd)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no fixed deposit with that id")
		return
	}
	if err != nil {
		s.fail(w, "update fixed deposit", err)
		return
	}
	view, err := fdViewOf(*updated, domain.NewDate(nowUTC()))
	if err != nil {
		s.fail(w, "value fixed deposit", err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) deleteFixedDeposit(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(mux.Vars(r)["id"], 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id must be an integer")
		return
	}
	err = s.store.DeleteFixedDeposit(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no fixed deposit with that id")
		return
	}
	if err != nil {
		s.fail(w, "delete fixed deposit", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeFD(w http.ResponseWriter, r *http.Request) (*domain.FixedDeposit, bool) {
	var fd domain.FixedDeposit
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&fd); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return nil, false
	}
	if err := fd.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, false
	}
	return &fd, true
}

func fdViewOf(fd domain.FixedDeposit, at domain.Date) (*fdView, error) {
	accrued, err := compute.Accrued(fd, at)
	if err != nil {
		return nil, err
	}
	value, err := compute.Value(fd, at)
	if err != nil {
		return nil, err
	}
	atMaturity, err := compute.Value(fd, fd.MaturityDate)
	if err != nil {
		return nil, err
	}
	return &fdView{
		FixedDeposit:    fd,
		Accrued:         accrued,
		Value:           value,
		AccruedAt:       at.String(),
		ValueAtMaturity: atMaturity,
	}, nil
}
