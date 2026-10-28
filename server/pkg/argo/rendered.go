package argo

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/util/template"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	wfutil "github.com/argoproj/argo-workflows/v4/workflow/util"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The workflow only stores templates as written. What a step actually ran with — every {{…}} and
// {{=…}} substituted — exists only in its pod: the controller serializes the rendered template into
// the pod's ARGO_TEMPLATE environment variable for the executor (or, when it is too large for an env
// var, into a ConfigMap named after the pod). Reading it back is the only way to show the exact
// values, so it is preferred whenever the pod still exists.

// RenderedTemplate is a node's template as the controller rendered it into the node's pod.
type RenderedTemplate struct {
	PodName string
	// JSON is the rendered template; empty when the pod is gone (garbage collected, or never created).
	JSON string
}

// RenderedTemplate reads the rendered template of a Pod node from its pod.
func (s *Servers) RenderedTemplate(ctx context.Context, wf *wfv1.Workflow, nodeID string) (*RenderedTemplate, error) {
	node, err := wf.Status.Nodes.Get(nodeID)
	if err != nil {
		return nil, fmt.Errorf("node %q not found in workflow %s/%s", nodeID, wf.Namespace, wf.Name)
	}
	if node.Type != wfv1.NodeTypePod {
		return &RenderedTemplate{}, nil
	}
	podName := wfutil.GeneratePodName(wf.Name, node.Name, wfutil.GetTemplateFromNode(*node), node.ID, wfutil.GetWorkflowPodNameVersion(wf))
	out := &RenderedTemplate{PodName: podName}

	pod, err := s.Clients.Kubernetes.CoreV1().Pods(wf.Namespace).Get(ctx, podName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	// The name is derived, so confirm the pod really is this node's before exposing its environment.
	if pod.Labels[common.LabelKeyWorkflow] != wf.Name || pod.Annotations[common.AnnotationKeyNodeID] != node.ID {
		return out, nil
	}

	// Which container carries it depends on the pod layout (init, supervisor or main); all carry the same.
	raw := ""
	for _, c := range append(pod.Spec.InitContainers, pod.Spec.Containers...) {
		for _, e := range c.Env {
			if e.Name == common.EnvVarTemplate && raw == "" {
				raw = e.Value
			}
		}
	}
	if raw == common.EnvVarTemplateOffloaded {
		cm, err := s.Clients.Kubernetes.CoreV1().ConfigMaps(wf.Namespace).Get(ctx, podName, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		raw = cm.Data[common.EnvVarTemplate]
	}
	if raw == "" || !json.Valid([]byte(raw)) {
		return out, nil
	}
	out.JSON = raw
	return out, nil
}

// EvaluatedExpression is the result of one {{=…}} expression: the text it renders to, or why not.
type EvaluatedExpression struct {
	Value string
	Error string
}

// Expression evaluation is bounded: the input comes from the browser, and expr-lang has no way to
// interrupt a running program, so a pathological expression is cut off by size and by wall clock.
const (
	maxExpressions      = 200
	maxExpressionLength = 4096
	evaluateTimeout     = 2 * time.Second
)

// EvaluateExpressions renders Argo expressions ({{=…}} bodies) the way the controller does: with
// Argo's own template engine — expr-lang plus the sprig, jsonpath, toJson and asInt helpers — against
// the given flat variables ("inputs.parameters.x", "workflow.name", …). It is an estimate: the
// variables are what the run recorded, which may differ from what the controller saw when it ran.
func EvaluateExpressions(ctx context.Context, expressions []string, variables map[string]string) ([]EvaluatedExpression, error) {
	if len(expressions) > maxExpressions {
		return nil, fmt.Errorf("at most %d expressions can be evaluated at once", maxExpressions)
	}
	env := template.ToAnyMap(variables)
	if logging.GetLoggerFromContextOrNil(ctx) == nil {
		ctx = logging.WithLogger(ctx, logging.NewSlogLogger(logging.Info, logging.JSON))
	}
	out := make([]EvaluatedExpression, len(expressions))
	for i, expression := range expressions {
		if len(expression) > maxExpressionLength {
			out[i] = EvaluatedExpression{Error: fmt.Sprintf("expression longer than %d characters", maxExpressionLength)}
			continue
		}
		out[i] = evaluate(ctx, expression, env)
	}
	return out, nil
}

func evaluate(ctx context.Context, expression string, env map[string]any) EvaluatedExpression {
	// Replace works on a JSON document (it is applied to the marshaled template), so the expression is
	// placed in a JSON string, escaped the way marshaling would, and the result decoded back out.
	escaped, _ := json.Marshal(expression)
	source := `"{{=` + string(escaped[1:len(escaped)-1]) + `}}"`

	done := make(chan EvaluatedExpression, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- EvaluatedExpression{Error: fmt.Sprint(r)}
			}
		}()
		rendered, err := template.Replace(ctx, source, env, false)
		if err != nil {
			done <- EvaluatedExpression{Error: strings.TrimPrefix(err.Error(), "failed to evaluate expression: ")}
			return
		}
		if rendered == source {
			done <- EvaluatedExpression{Error: "left unresolved"}
			return
		}
		var value string
		if err := json.Unmarshal([]byte(rendered), &value); err != nil {
			done <- EvaluatedExpression{Error: err.Error()}
			return
		}
		done <- EvaluatedExpression{Value: value}
	}()
	select {
	case r := <-done:
		return r
	case <-time.After(evaluateTimeout):
		return EvaluatedExpression{Error: "evaluation timed out"}
	case <-ctx.Done():
		return EvaluatedExpression{Error: ctx.Err().Error()}
	}
}
