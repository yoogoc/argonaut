package argo

import (
	"context"
	"sort"
	"strconv"
	"strings"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Listing goes straight to the Kubernetes API instead of through Argo's ListWorkflows. That method
// paginates by integer offset — semantics built for its SQLite cache and its archive merging — and
// its KubeLister branch forwards that offset to Kubernetes as a `continue` token, which Kubernetes
// rejects. Talking to the clientset lets us page correctly and sort the whole result ourselves, and
// phase filtering still works because Argo labels every workflow with its phase.
//
// Everything else (Get, actions, logs, watch) does go through Argo's server so that node status
// hydration and retry/resubmit semantics stay Argo's own.

// maxListItems caps how much of a namespace a single list may pull. Ordering by time requires seeing
// every candidate (see ListWorkflows), so without a cap one enormous namespace could exhaust memory.
const maxListItems = 5000

// kubePageSize bounds a single round trip to the API server while reading a whole namespace.
const kubePageSize = 500

// ListOptions describes a page of resources to fetch.
type ListOptions struct {
	Namespace     string
	LabelSelector string
	// NamePattern filters names by substring, applied client-side because Kubernetes field
	// selectors only support exact name matches.
	NamePattern string
	// Phases filters workflow status; ignored for templates and cron workflows.
	Phases []string
	Limit  int64
	// ContinueToken is an offset into the sorted result, not a Kubernetes continue token: the sort
	// order is ours, so paging has to be ours too.
	ContinueToken string
}

// ListWorkflows returns the workflows of a namespace, newest first.
//
// Kubernetes can neither sort nor filter by time: it returns objects in name order and pages over
// that order, which is why an unsorted list looks alphabetical. Argo's own server sorts only within
// the page it fetched and says so — "we make no promises about the overall list sorting". A console
// whose main question is "what ran recently" needs a real answer, so this reads the whole namespace
// (bounded by maxListItems) and sorts it before anything is paginated.
//
// Ordering is strictly newest-created first. Argo's own comparator is deliberately not reused: it
// orders finished workflows by finish time, so a run created earlier but finished later jumps ahead of
// one created after it — confusing next to a "Started" column.
func (s *Servers) ListWorkflows(ctx context.Context, opts ListOptions) (*wfv1.WorkflowList, error) {
	listOptions := opts.toKube()
	if selector := phaseSelector(opts.Phases); selector != "" {
		listOptions.LabelSelector = joinSelectors(listOptions.LabelSelector, selector)
	}
	s.Instance.With(&listOptions)

	client := s.Clients.Workflow.ArgoprojV1alpha1().Workflows(s.namespaceFor(opts.Namespace))

	var (
		items     []wfv1.Workflow
		last      *wfv1.WorkflowList
		truncated bool
	)
	// Page through Kubernetes rather than asking for everything at once, so one request never has to
	// be served from a single huge response.
	for {
		list, err := client.List(ctx, listOptions)
		if err != nil {
			return nil, err
		}
		last = list
		for i := range list.Items {
			if opts.NamePattern != "" && !strings.Contains(list.Items[i].Name, opts.NamePattern) {
				continue
			}
			items = append(items, list.Items[i])
		}
		if list.Continue == "" || len(items) >= maxListItems {
			truncated = list.Continue != ""
			break
		}
		listOptions.Continue = list.Continue
	}

	sortByCreation(items, func(w wfv1.Workflow) metav1.Time { return w.CreationTimestamp })

	out := &wfv1.WorkflowList{Items: items}
	if last != nil {
		out.ListMeta = last.ListMeta
	}
	// Continue carries the Kubernetes token we already consumed; the caller pages by offset instead.
	out.Continue = ""
	if truncated {
		s.log.Warn("workflow list truncated",
			"namespace", s.namespaceFor(opts.Namespace), "cap", maxListItems,
			"detail", "ordering covers only the workflows that were read")
	}
	return out, nil
}

// Page returns the requested window of a sorted list and reports what remains, so ordering is decided
// once over the whole result rather than per Kubernetes page.
func Page[T any](items []T, offset string, limit int64) (window []T, nextOffset string, remaining int64) {
	start := 0
	if offset != "" {
		if parsed, err := strconv.Atoi(offset); err == nil && parsed > 0 {
			start = parsed
		}
	}
	if start > len(items) {
		start = len(items)
	}
	end := len(items)
	if limit > 0 && start+int(limit) < end {
		end = start + int(limit)
	}
	window = items[start:end]
	remaining = int64(len(items) - end)
	if remaining > 0 {
		nextOffset = strconv.Itoa(end)
	}
	return window, nextOffset, remaining
}

// ListWorkflowTemplates returns a page of workflow templates.
func (s *Servers) ListWorkflowTemplates(ctx context.Context, opts ListOptions) (*wfv1.WorkflowTemplateList, error) {
	listOptions := opts.toKube()
	s.Instance.With(&listOptions)
	client := s.Clients.Workflow.ArgoprojV1alpha1().WorkflowTemplates(s.namespaceFor(opts.Namespace))

	var items []wfv1.WorkflowTemplate
	for {
		list, err := client.List(ctx, listOptions)
		if err != nil {
			return nil, err
		}
		for i := range list.Items {
			if opts.NamePattern != "" && !strings.Contains(list.Items[i].Name, opts.NamePattern) {
				continue
			}
			items = append(items, list.Items[i])
		}
		if list.Continue == "" || len(items) >= maxListItems {
			break
		}
		listOptions.Continue = list.Continue
	}

	sortByCreation(items, func(t wfv1.WorkflowTemplate) metav1.Time { return t.CreationTimestamp })
	return &wfv1.WorkflowTemplateList{Items: items}, nil
}

// ListCronWorkflows returns a page of cron workflows.
func (s *Servers) ListCronWorkflows(ctx context.Context, opts ListOptions) (*wfv1.CronWorkflowList, error) {
	listOptions := opts.toKube()
	s.Instance.With(&listOptions)
	client := s.Clients.Workflow.ArgoprojV1alpha1().CronWorkflows(s.namespaceFor(opts.Namespace))

	var items []wfv1.CronWorkflow
	for {
		list, err := client.List(ctx, listOptions)
		if err != nil {
			return nil, err
		}
		for i := range list.Items {
			if opts.NamePattern != "" && !strings.Contains(list.Items[i].Name, opts.NamePattern) {
				continue
			}
			items = append(items, list.Items[i])
		}
		if list.Continue == "" || len(items) >= maxListItems {
			break
		}
		listOptions.Continue = list.Continue
	}

	sortByCreation(items, func(c wfv1.CronWorkflow) metav1.Time { return c.CreationTimestamp })
	return &wfv1.CronWorkflowList{Items: items}, nil
}

// GetCronWorkflow fetches one cron workflow, needed before authorizing an action on it.
func (s *Servers) GetCronWorkflow(ctx context.Context, namespace, name string) (*wfv1.CronWorkflow, error) {
	return s.Clients.Workflow.ArgoprojV1alpha1().CronWorkflows(s.namespaceFor(namespace)).Get(ctx, name, metav1.GetOptions{})
}

// namespaceFor honours a managed namespace: when the server is pinned to one namespace, requests
// cannot escape it.
func (s *Servers) namespaceFor(requested string) string {
	if s.Namespace != "" {
		return s.Namespace
	}
	return requested
}

// NamespaceFor is the exported form, used to validate incoming requests.
func (s *Servers) NamespaceFor(requested string) string {
	return s.namespaceFor(requested)
}

// toKube carries only the filters Kubernetes itself can apply. Limit and ContinueToken are
// deliberately left out: they page our sorted result, and forwarding them would let Kubernetes
// truncate the set in name order before there is anything to sort.
func (o ListOptions) toKube() metav1.ListOptions {
	return metav1.ListOptions{
		LabelSelector: o.LabelSelector,
		// kubePageSize keeps each round trip bounded while we read the whole namespace.
		Limit: kubePageSize,
	}
}

// sortByCreation puts the newest first. Templates and cron workflows need this for the same reason
// workflows do: Kubernetes hands back name order.
func sortByCreation[T any](items []T, createdAt func(T) metav1.Time) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := createdAt(items[i]), createdAt(items[j])
		return b.Before(&a)
	})
}

// phaseSelector turns a phase filter into a label selector. Argo maintains a phase label precisely
// so this kind of filtering does not need a field selector, which CRDs do not support.
func phaseSelector(phases []string) string {
	cleaned := make([]string, 0, len(phases))
	for _, p := range phases {
		if p = strings.TrimSpace(p); p != "" {
			cleaned = append(cleaned, p)
		}
	}
	if len(cleaned) == 0 {
		return ""
	}
	return common.LabelKeyPhase + " in (" + strings.Join(cleaned, ",") + ")"
}

func joinSelectors(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	default:
		return a + "," + b
	}
}
