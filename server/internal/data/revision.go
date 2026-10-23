package data

import (
	"context"
	"errors"
	"strconv"

	"argonaut/internal/biz"
	"argonaut/pkg/id"

	kerrors "github.com/go-kratos/kratos/v3/errors"
	"github.com/jackc/pgx/v5"
)

type revisionRepo struct {
	data *Data
}

// NewRevisionRepo returns the template history repository.
func NewRevisionRepo(data *Data) biz.RevisionRepo {
	return &revisionRepo{data: data}
}

func (r *revisionRepo) Record(ctx context.Context, rev biz.TemplateRevision) (biz.TemplateRevision, bool, error) {
	recorded := false
	err := pgx.BeginFunc(ctx, r.data.pool, func(tx pgx.Tx) error {
		// Serialize writers of the same template so sequence numbers stay dense and the duplicate
		// check below sees every earlier insert.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, rev.Cluster+"/"+rev.Scope+"/"+rev.Namespace+"/"+rev.Name); err != nil {
			return err
		}
		var latestRV string
		var seq int
		err := tx.QueryRow(ctx, `SELECT resource_version, seq FROM template_revisions WHERE cluster=$1 AND scope=$2 AND namespace=$3 AND name=$4 ORDER BY seq DESC LIMIT 1`,
			rev.Cluster, rev.Scope, rev.Namespace, rev.Name).Scan(&latestRV, &seq)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if latestRV != "" && latestRV == rev.ResourceVersion {
			return nil
		}
		newID := id.Generate()
		rev.Seq = seq + 1
		rev.ID = strconv.FormatInt(newID, 10)
		_, err = tx.Exec(ctx, `INSERT INTO template_revisions (id, cluster, scope, namespace, name, seq, uid, resource_version, manifest, author, external, message)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
			newID, rev.Cluster, rev.Scope, rev.Namespace, rev.Name, rev.Seq, rev.UID, rev.ResourceVersion, string(rev.Manifest), rev.Author, rev.External, rev.Message)
		recorded = err == nil
		return err
	})
	return rev, recorded, err
}

func scanRevision(withManifest bool) pgx.RowToFunc[biz.TemplateRevision] {
	return func(row pgx.CollectableRow) (biz.TemplateRevision, error) {
		var rev biz.TemplateRevision
		var numeric int64
		var manifest string
		dest := []any{&numeric, &rev.Cluster, &rev.Scope, &rev.Namespace, &rev.Name, &rev.Seq, &rev.UID, &rev.ResourceVersion, &rev.Author, &rev.External, &rev.Message, &rev.CreatedAt}
		if withManifest {
			dest = append(dest, &manifest)
		}
		err := row.Scan(dest...)
		rev.ID = strconv.FormatInt(numeric, 10)
		if manifest != "" {
			rev.Manifest = []byte(manifest)
		}
		return rev, err
	}
}

const revisionColumns = `id, cluster, scope, namespace, name, seq, uid, resource_version, author, external, message, created_at`

func (r *revisionRepo) List(ctx context.Context, cluster, scope, namespace, name string) ([]biz.TemplateRevision, error) {
	rows, err := r.data.pool.Query(ctx, `SELECT `+revisionColumns+` FROM template_revisions
		WHERE cluster=$1 AND scope=$2 AND namespace=$3 AND name=$4 ORDER BY seq DESC`, cluster, scope, namespace, name)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanRevision(false))
}

func (r *revisionRepo) Get(ctx context.Context, idStr string) (biz.TemplateRevision, error) {
	numeric, err := parseID(idStr)
	if err != nil {
		return biz.TemplateRevision{}, err
	}
	rows, err := r.data.pool.Query(ctx, `SELECT `+revisionColumns+`, manifest::text FROM template_revisions WHERE id=$1`, numeric)
	if err != nil {
		return biz.TemplateRevision{}, err
	}
	rev, err := pgx.CollectExactlyOneRow(rows, scanRevision(true))
	if errors.Is(err, pgx.ErrNoRows) {
		return biz.TemplateRevision{}, kerrors.NotFound("not_found", "revision not found")
	}
	return rev, err
}

func (r *revisionRepo) HasResourceVersion(ctx context.Context, cluster, scope, namespace, name, resourceVersion string) (bool, error) {
	var exists bool
	err := r.data.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM template_revisions WHERE cluster=$1 AND scope=$2 AND namespace=$3 AND name=$4 AND resource_version=$5)`,
		cluster, scope, namespace, name, resourceVersion).Scan(&exists)
	return exists, err
}
