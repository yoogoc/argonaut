package biz

import (
	"context"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"argonaut/internal/authz"

	"github.com/go-kratos/kratos/v3/errors"
)

// User is a local directory entry populated from a verified ID token.
type User struct {
	Subject       string
	Name          string
	Email         string
	EmailVerified bool
	LastLoginAt   *time.Time
}

// NormalizeEmail accepts a bare address and uses the same case-insensitive key for grants and login.
func NormalizeEmail(value string) string {
	value = strings.TrimSpace(value)
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || address.Name != "" || len(value) > 254 {
		return ""
	}
	return strings.ToLower(value)
}

func (uc *AuthzUsecase) RecordLogin(ctx context.Context, user User) error {
	rev, err := uc.repo.RecordLogin(ctx, user)
	if err != nil {
		uc.log.Error("updating user directory after login failed", "err", err, "subject", user.Subject)
		// Keep bootstrap administrators able to recover from a database outage.
		if uc.engine.IsSuperAdmin(user.Subject) {
			return nil
		}
		return errors.ServiceUnavailable("user_directory_unavailable", "could not record sign-in; try again shortly")
	}
	if rev > uc.engine.Revision() {
		if err := uc.reload(ctx); err != nil {
			uc.log.Error("reload after binding email grants failed", "err", err)
		}
	}
	return nil
}

// SearchUsers is limited to callers allowed to grant permissions on the selected resource.
func (uc *AuthzUsecase) SearchUsers(ctx context.Context, query string, resource authz.Resource) ([]User, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, resource); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if utf8.RuneCountInString(query) < 2 {
		return nil, nil
	}
	if len(query) > 512 {
		return nil, errors.BadRequest("invalid_argument", "user search is too long")
	}
	return uc.repo.FindUsers(ctx, query, 20, 0)
}

// ListUsers requires global grant permission because it exposes the platform-wide directory.
func (uc *AuthzUsecase) ListUsers(ctx context.Context, query string, limit, offset int) ([]User, bool, error) {
	if err := uc.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return nil, false, err
	}
	query = strings.TrimSpace(query)
	if len(query) > 512 {
		return nil, false, errors.BadRequest("invalid_argument", "user search is too long")
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 0 || limit > 100 || offset < 0 {
		return nil, false, errors.BadRequest("invalid_argument", "invalid user directory page")
	}
	users, err := uc.repo.FindUsers(ctx, query, limit+1, offset)
	if err != nil {
		return nil, false, err
	}
	if len(users) > limit {
		return users[:limit], true, nil
	}
	return users, false, nil
}
