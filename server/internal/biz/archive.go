package biz

import (
	"context"
	stderrors "errors"
	"io"
	"log/slog"
	"slices"
	"strconv"

	"argonaut/internal/authz"
	pkgargo "argonaut/pkg/argo"

	"github.com/argoproj/argo-workflows/v4/pkg/apiclient/workflowarchive"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	sutils "github.com/argoproj/argo-workflows/v4/server/utils"
	"github.com/go-kratos/kratos/v3/errors"
	"k8s.io/apimachinery/pkg/labels"
)

// archiveScanBatch is how many archived rows are read per round while filling a page. Authorization
// filters per run, so a page may need several rounds for a user who may see only part of a namespace.
const archiveScanBatch = 200

// ArchiveUsecase serves the workflow archive (DESIGN §2.4). Archived runs keep their labels and
// spec, so they are attributed to a template scope and authorized exactly like live ones.
type ArchiveUsecase struct {
	log   *slog.Logger
	sw    *pkgargo.ClusterSwitch
	authz *AuthzUsecase
	wf    *WorkflowUsecase
}

func NewArchiveUsecase(sw *pkgargo.ClusterSwitch, authzUC *AuthzUsecase, wf *WorkflowUsecase, logger *slog.Logger) *ArchiveUsecase {
	return &ArchiveUsecase{log: logger.With("module", "biz/archive"), sw: sw, authz: authzUC, wf: wf}
}

// servers and cache are the Argo servers and informer cache of the cluster the request was pinned to
// (pkgargo.ClusterSwitch), so one request never spans two clusters.
func (uc *ArchiveUsecase) servers(ctx context.Context) *pkgargo.Servers {
	return uc.sw.For(ctx).Servers
}

// ArchiveListOptions selects archived runs. ContinueToken is the archive offset to resume scanning
// from, so a page boundary never skips or repeats a run however many were filtered out.
type ArchiveListOptions struct {
	Namespace     string
	NamePrefix    string
	LabelSelector string
	Phases        []string
	Limit         int
	ContinueToken string
}

// List returns one page of the archived runs the caller may see, newest first.
func (uc *ArchiveUsecase) List(ctx context.Context, opts ArchiveListOptions) (*wfv1.WorkflowList, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	requirements, err := labels.ParseToRequirements(opts.LabelSelector)
	if err != nil {
		return nil, errors.BadRequest("invalid_argument", "labelSelector: "+err.Error())
	}
	limit := opts.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	offset := 0
	if opts.ContinueToken != "" {
		if offset, err = strconv.Atoi(opts.ContinueToken); err != nil || offset < 0 {
			return nil, errors.BadRequest("invalid_argument", "continueToken is not valid")
		}
	}

	base := sutils.ListOptions{
		Namespace:         uc.servers(ctx).NamespaceFor(opts.Namespace),
		NamePrefix:        opts.NamePrefix,
		LabelRequirements: requirements,
	}
	items := make([]wfv1.Workflow, 0, limit)
	next := ""
scan:
	for {
		batch, err := uc.servers(ctx).Archive.ListWorkflows(uc.wf.argoContext(ctx), base.WithLimit(archiveScanBatch).WithOffset(offset))
		if err != nil {
			return nil, errors.InternalServer("archive", err.Error())
		}
		for i := range batch {
			offset++
			wf := &batch[i]
			if len(opts.Phases) > 0 && !slices.Contains(opts.Phases, string(wf.Status.Phase)) {
				continue
			}
			if !uc.authz.Allow(ctx, authz.WorkflowList, WorkflowResource(wf)) {
				continue
			}
			items = append(items, *wf)
			if len(items) == limit {
				// More rows follow unless this was the last row of a short (final) batch.
				if i < len(batch)-1 || len(batch) == archiveScanBatch {
					next = strconv.Itoa(offset)
				}
				break scan
			}
		}
		if len(batch) < archiveScanBatch {
			break
		}
	}
	list := &wfv1.WorkflowList{Items: items}
	list.Continue = next
	return list, nil
}

// Get returns a full archived run.
func (uc *ArchiveUsecase) Get(ctx context.Context, uid, namespace string) (*wfv1.Workflow, error) {
	return uc.authorize(ctx, uid, namespace, authz.WorkflowGet)
}

func (uc *ArchiveUsecase) authorize(ctx context.Context, uid, namespace string, action authz.Action) (*wfv1.Workflow, error) {
	if err := uc.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	wf, err := uc.servers(ctx).Archive.GetWorkflow(uc.wf.argoContext(ctx), uid, namespace, "")
	if err != nil {
		return nil, errors.InternalServer("archive", err.Error())
	}
	// A run outside the managed namespaces is reported as missing rather than forbidden, so the
	// archive does not reveal which UIDs exist elsewhere.
	if wf == nil || (uc.servers(ctx).Namespace != "" && wf.Namespace != uc.servers(ctx).Namespace) {
		return nil, errors.NotFound("not_found", "archived workflow "+uid+" not found")
	}
	if err := uc.authz.Require(ctx, action, WorkflowResource(wf)); err != nil {
		return nil, err
	}
	return wf, nil
}

// Delete removes a run from the archive.
func (uc *ArchiveUsecase) Delete(ctx context.Context, uid, namespace string) error {
	wf, err := uc.authorize(ctx, uid, namespace, authz.WorkflowDelete)
	if err != nil {
		return err
	}
	if err := uc.servers(ctx).Archive.DeleteWorkflow(uc.wf.argoContext(ctx), uid); err != nil {
		return errors.InternalServer("archive", err.Error())
	}
	uc.wf.done(ctx, authz.WorkflowDelete, wf, map[string]any{"archived": true, "uid": uid})
	return nil
}

// Resubmit creates a new run from an archived one.
func (uc *ArchiveUsecase) Resubmit(ctx context.Context, uid string, memoized bool, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorize(ctx, uid, "", authz.WorkflowResubmit)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).ArchivedServer.ResubmitArchivedWorkflow(uc.wf.argoContext(ctx), &workflowarchive.ResubmitArchivedWorkflowRequest{
		Uid:        uid,
		Namespace:  wf.Namespace,
		Memoized:   memoized,
		Parameters: parameters,
	})
	if err != nil {
		return nil, err
	}
	uc.wf.done(ctx, authz.WorkflowResubmit, wf, map[string]any{"archived": true, "uid": uid, "created": out.Name})
	return out, nil
}

// Retry recreates an archived run in the cluster and retries it. Argo refuses when a workflow of the
// same name still exists, since that one should be retried directly.
func (uc *ArchiveUsecase) Retry(ctx context.Context, uid string, restartSuccessful bool, nodeFieldSelector string, parameters []string) (*wfv1.Workflow, error) {
	wf, err := uc.authorize(ctx, uid, "", authz.WorkflowRetry)
	if err != nil {
		return nil, err
	}
	out, err := uc.servers(ctx).ArchivedServer.RetryArchivedWorkflow(uc.wf.argoContext(ctx), &workflowarchive.RetryArchivedWorkflowRequest{
		Uid:               uid,
		Namespace:         wf.Namespace,
		RestartSuccessful: restartSuccessful,
		NodeFieldSelector: nodeFieldSelector,
		Parameters:        parameters,
	})
	if err != nil {
		return nil, err
	}
	uc.wf.done(ctx, authz.WorkflowRetry, wf, map[string]any{"archived": true, "uid": uid})
	return out, nil
}

// Logs streams a step's archived log; an archived run has no pods left to read from.
func (uc *ArchiveUsecase) Logs(ctx context.Context, uid, nodeID, grep string, send func(content, podName string) error) error {
	wf, err := uc.authorize(ctx, uid, "", authz.WorkflowLogs)
	if err != nil {
		return err
	}
	err = uc.servers(ctx).StreamArchivedLogs(uc.wf.argoContext(ctx), wf, nodeID, grep, func(line pkgargo.ArchivedLogLine) error {
		return send(line.Content, line.PodName)
	})
	if stderrors.Is(err, pkgargo.ErrNoArchivedLogs) {
		return send("This step kept no archived logs (archiveLogs was off when it ran).", nodeID)
	}
	return err
}

// OpenArtifact authorizes and opens an archived run's artifact for streaming.
func (uc *ArchiveUsecase) OpenArtifact(ctx context.Context, uid, nodeID, artifactName string, isInput bool) (*wfv1.Artifact, io.ReadCloser, error) {
	wf, err := uc.authorize(ctx, uid, "", authz.WorkflowArtifacts)
	if err != nil {
		return nil, nil, err
	}
	return uc.servers(ctx).Artifacts.Open(uc.wf.argoContext(ctx), wf, nodeID, artifactName, isInput)
}
