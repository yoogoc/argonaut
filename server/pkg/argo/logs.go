package argo

import (
	"bufio"
	"context"
	"fmt"
	"regexp"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Argo streams container logs by listing the workflow's pods and reading from each one. Once the pods
// have been garbage collected that list is empty, and the stream ends with no data and no error — a
// finished workflow simply appears to have no logs. Argo's own console papers over this in the browser
// by fetching the archived log artifact instead; argonaut does it here, so any client gets logs for as
// long as the artifacts exist.

// LogsAvailableLive reports whether the pods needed to stream live logs still exist.
func (s *Servers) LogsAvailableLive(ctx context.Context, namespace, workflowName, podName string) (bool, error) {
	pods := s.Clients.Kubernetes.CoreV1().Pods(s.namespaceFor(namespace))

	if podName != "" {
		if _, err := pods.Get(ctx, podName, metav1.GetOptions{}); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}

	// Without a pod name the caller wants the whole workflow, which Argo serves by label.
	list, err := pods.List(ctx, metav1.ListOptions{
		LabelSelector: common.LabelKeyWorkflow + "=" + workflowName,
		Limit:         1,
	})
	if err != nil {
		return false, err
	}
	return len(list.Items) > 0, nil
}

// ArchivedLogLine is one line recovered from a node's stored log artifact.
type ArchivedLogLine struct {
	Content string
	// PodName identifies which step the line came from, matching what live streaming reports.
	PodName string
}

// StreamArchivedLogs replays the stored logs of a workflow's nodes.
//
// nodeID limits it to one node; empty covers every node that ran a pod, which is what a
// whole-workflow log request means. A node whose artifact is missing is skipped rather than failing
// the stream: artifacts expire independently, and one gap should not hide the rest of the run.
func (s *Servers) StreamArchivedLogs(
	ctx context.Context,
	wf *wfv1.Workflow,
	nodeID string,
	grep string,
	send func(ArchivedLogLine) error,
) error {
	matcher, err := regexp.Compile(grep)
	if err != nil {
		return fmt.Errorf("invalid grep %q: %w", grep, err)
	}

	nodes := make([]wfv1.NodeStatus, 0, 1)
	if nodeID != "" {
		node, err := wf.Status.Nodes.Get(nodeID)
		if err != nil {
			return fmt.Errorf("node %q not found in workflow %s/%s", nodeID, wf.Namespace, wf.Name)
		}
		nodes = append(nodes, *node)
	} else {
		for _, node := range wf.Status.Nodes {
			if node.Type == wfv1.NodeTypePod {
				nodes = append(nodes, node)
			}
		}
	}

	found := 0
	for _, node := range nodes {
		if ctx.Err() != nil {
			return nil
		}
		reader, err := s.Artifacts.OpenLogs(ctx, wf, node.ID)
		if err != nil {
			s.log.Debug("no archived logs for node",
				"workflow", wf.Name, "node", node.ID, "err", err)
			continue
		}
		found++

		label := node.DisplayName
		if label == "" {
			label = node.ID
		}

		scanner := bufio.NewScanner(reader)
		// Argo log lines can be long (a stack trace on one line); the default 64KB limit would
		// truncate them into a scan error and cut the rest of the file short.
		scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if !matcher.MatchString(line) {
				continue
			}
			if err := send(ArchivedLogLine{Content: line, PodName: label}); err != nil {
				_ = reader.Close()
				return err
			}
		}
		scanErr := scanner.Err()
		if cerr := reader.Close(); cerr != nil {
			s.log.Warn("closing archived log reader", "node", node.ID, "err", cerr)
		}
		if scanErr != nil {
			return fmt.Errorf("reading archived logs of node %s: %w", node.ID, scanErr)
		}
	}

	if found == 0 {
		return ErrNoArchivedLogs
	}
	return nil
}

// ErrNoArchivedLogs means neither the pods nor their stored logs are available any more, which
// callers report as an explanation rather than as a failure.
var ErrNoArchivedLogs = fmt.Errorf("no archived logs available")
