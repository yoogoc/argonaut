package biz

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"

	"argonaut/internal/authz"
	"argonaut/internal/conf"
	"argonaut/internal/viewer"
	pkgargo "argonaut/pkg/argo"

	persist "github.com/argoproj/argo-workflows/v4/persist/sqldb"
	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	sutils "github.com/argoproj/argo-workflows/v4/server/utils"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/go-kratos/kratos/v3/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8stypes "k8s.io/apimachinery/pkg/types"
)

// fakeArchive serves a fixed, newest-first list the way the SQL archive pages it.
type fakeArchive struct {
	persist.WorkflowArchive
	items []wfv1.Workflow
	reads int
}

func (f *fakeArchive) ListWorkflows(_ context.Context, o sutils.ListOptions) (wfv1.Workflows, error) {
	f.reads++
	var matched wfv1.Workflows
	for _, wf := range f.items {
		if o.Namespace == "" || wf.Namespace == o.Namespace {
			matched = append(matched, wf)
		}
	}
	if o.Offset >= len(matched) {
		return wfv1.Workflows{}, nil
	}
	end := min(o.Offset+o.Limit, len(matched))
	return matched[o.Offset:end], nil
}

func (f *fakeArchive) GetWorkflow(_ context.Context, uid, _, _ string) (*wfv1.Workflow, error) {
	for i := range f.items {
		if string(f.items[i].UID) == uid {
			return &f.items[i], nil
		}
	}
	return nil, nil
}

func archived(i int, namespace, template string) wfv1.Workflow {
	return wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{
		Name:      fmt.Sprintf("run-%03d", i),
		Namespace: namespace,
		UID:       metaUID(i),
		Labels:    map[string]string{common.LabelKeyWorkflowTemplate: template},
	}}
}

func metaUID(i int) k8stypes.UID { return k8stypes.UID(fmt.Sprintf("uid-%03d", i)) }

func newArchiveTest(t *testing.T, items []wfv1.Workflow, managed string) (*ArchiveUsecase, *fakeArchive) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine, err := authz.NewEngine(&conf.Authz{}, logger)
	if err != nil {
		t.Fatal(err)
	}
	// alice may see the runs of template "etl" only.
	engine.Load(authz.Snapshot{Revision: 1, Grants: []authz.Grant{{Subject: "alice", ResourceType: authz.ResourceTemplate, Namespace: "argo", Name: "etl", Role: authz.RoleViewer}}})
	fake := &fakeArchive{items: items}
	servers := &pkgargo.Servers{Archive: fake, Clients: &pkgargo.Clients{}, Namespace: managed}
	authzUC := &AuthzUsecase{log: logger, engine: engine}
	wf := &WorkflowUsecase{log: logger, servers: servers, authz: authzUC}
	return NewArchiveUsecase(servers, authzUC, wf, logger), fake
}

func alice() context.Context {
	return viewer.NewUserContext(context.Background(), &viewer.UserViewer{Subject: "alice"})
}

func TestArchiveListPaginatesAfterAuthorizing(t *testing.T) {
	// 450 runs, every third from etl: a page must be filled from several archive reads, and the
	// continue token must resume exactly after the last row scanned.
	var items []wfv1.Workflow
	for i := range 450 {
		tpl := "other"
		if i%3 == 0 {
			tpl = "etl"
		}
		items = append(items, archived(i, "argo", tpl))
	}
	uc, fake := newArchiveTest(t, items, "")

	seen := map[string]bool{}
	token := ""
	pages := 0
	for {
		list, err := uc.List(alice(), ArchiveListOptions{Namespace: "argo", Limit: 40, ContinueToken: token})
		if err != nil {
			t.Fatal(err)
		}
		for _, wf := range list.Items {
			if wf.Labels[common.LabelKeyWorkflowTemplate] != "etl" {
				t.Fatalf("page leaked %s from another template", wf.Name)
			}
			if seen[wf.Name] {
				t.Fatalf("%s returned twice", wf.Name)
			}
			seen[wf.Name] = true
		}
		pages++
		if list.Continue == "" {
			break
		}
		if len(list.Items) != 40 {
			t.Fatalf("non-final page has %d items", len(list.Items))
		}
		token = list.Continue
	}
	if len(seen) != 150 {
		t.Fatalf("saw %d etl runs, want 150", len(seen))
	}
	if pages != 4 || fake.reads < 4 {
		t.Fatalf("pages=%d reads=%d", pages, fake.reads)
	}
}

func TestArchiveGetAuthorizesAndHidesOtherNamespaces(t *testing.T) {
	items := []wfv1.Workflow{archived(1, "argo", "etl"), archived(2, "argo", "other"), archived(3, "elsewhere", "etl")}
	uc, _ := newArchiveTest(t, items, "argo")

	if _, err := uc.Get(alice(), "uid-001", ""); err != nil {
		t.Fatalf("granted run refused: %v", err)
	}
	if _, err := uc.Get(alice(), "uid-002", ""); errors.Code(err) != 403 {
		t.Fatalf("ungranted run: got %v, want 403", err)
	}
	if _, err := uc.Get(alice(), "uid-003", ""); errors.Code(err) != 404 {
		t.Fatalf("run outside the managed namespace: got %v, want 404", err)
	}
	if _, err := uc.Get(context.Background(), "uid-001", ""); errors.Code(err) != 401 {
		t.Fatalf("anonymous: got %v, want 401", err)
	}
}
