package biz

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"strings"
	"unicode/utf8"

	"argonaut/internal/authz"
	"argonaut/internal/conf"

	"github.com/go-kratos/kratos/v3/errors"
)

type NewAccount struct {
	Name  string
	Email string
}

type AccountRepo interface {
	SetupComplete(ctx context.Context) (bool, error)
	BootstrapAdmin(ctx context.Context, account NewAccount) (int64, error)
	CreateLocalUser(ctx context.Context, account NewAccount, actor string) error
}

type Accounts struct {
	authz *AuthzUsecase
	repo  AccountRepo
	sso   *conf.SSO
	token string
}

func NewAccounts(uc *AuthzUsecase, sso *conf.SSO, config *conf.Authz) *Accounts {
	return &Accounts{authz: uc, repo: uc.repo, sso: sso, token: config.GetSetupToken()}
}

func (a *Accounts) Available() bool { return a.sso.GetIssuer() != "" }

func (a *Accounts) SetupStatus(ctx context.Context) (required, available bool, err error) {
	if !a.sso.GetEnabled() || a.authz.engine.HasConfiguredAdmins() {
		return false, false, nil
	}
	complete, err := a.repo.SetupComplete(ctx)
	if err != nil {
		return false, false, err
	}
	return !complete, !complete && len(a.token) >= 32 && a.Available(), nil
}

func (a *Accounts) SetupAdmin(ctx context.Context, token string, account NewAccount) (User, error) {
	want, got := sha256.Sum256([]byte(a.token)), sha256.Sum256([]byte(token))
	if len(a.token) < 32 || subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		return User{}, errors.Forbidden("invalid_setup_token", "invalid setup token")
	}
	required, available, err := a.SetupStatus(ctx)
	if err != nil {
		return User{}, err
	}
	if !required {
		return User{}, errors.Conflict("setup_complete", "the platform already has an administrator")
	}
	if !available {
		return User{}, errors.ServiceUnavailable("oidc_unavailable", "configure an OIDC issuer before creating an administrator")
	}
	if err := normalizeAccount(&account); err != nil {
		return User{}, err
	}
	rev, err := a.repo.BootstrapAdmin(ctx, account)
	if err == nil && rev > a.authz.engine.Revision() {
		if err := a.authz.reload(ctx); err != nil {
			a.authz.log.Error("reload after administrator setup failed", "err", err)
		}
	}
	return User{Name: account.Name, Email: account.Email}, err
}

func (a *Accounts) CreateUser(ctx context.Context, account NewAccount) (User, error) {
	if err := a.authz.Require(ctx, authz.AuthzGrant, authz.Global()); err != nil {
		return User{}, err
	}
	if !a.Available() {
		return User{}, errors.ServiceUnavailable("oidc_unavailable", "configure an OIDC issuer before creating users")
	}
	if err := normalizeAccount(&account); err != nil {
		return User{}, err
	}
	if err := a.repo.CreateLocalUser(ctx, account, a.authz.Subject(ctx)); err != nil {
		return User{}, err
	}
	return User{Name: account.Name, Email: account.Email}, nil
}

func normalizeAccount(account *NewAccount) error {
	account.Name = strings.TrimSpace(account.Name)
	account.Email = NormalizeEmail(account.Email)
	if account.Email == "" {
		return errors.BadRequest("invalid_email", "a valid email address is required")
	}
	if utf8.RuneCountInString(account.Name) > 128 {
		return errors.BadRequest("invalid_name", "name must be at most 128 characters")
	}
	if account.Name == "" {
		account.Name = account.Email
	}
	return nil
}
