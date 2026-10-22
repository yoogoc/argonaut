package argo

import (
	"fmt"
	"strings"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
)

// ParamFilter is one term of a run-parameter filter on the workflow list.
type ParamFilter struct {
	Name string
	// Op is "=" (exact value), "~" (case-insensitive substring) or "" (the parameter is present).
	Op    string
	Value string
}

// ParseParamFilters parses "name=value", "name~text" and "name" terms. The operator is the first
// "=" or "~", so a value may itself contain either.
func ParseParamFilters(terms []string) ([]ParamFilter, error) {
	var out []ParamFilter
	for _, term := range terms {
		term = strings.TrimSpace(term)
		if term == "" {
			continue
		}
		f := ParamFilter{Name: term}
		if i := strings.IndexAny(term, "=~"); i >= 0 {
			f = ParamFilter{Name: strings.TrimSpace(term[:i]), Op: term[i : i+1], Value: strings.TrimSpace(term[i+1:])}
		}
		if f.Name == "" {
			return nil, fmt.Errorf("parameter filter %q has no parameter name", term)
		}
		if f.Op == "~" {
			f.Value = strings.ToLower(f.Value)
		}
		out = append(out, f)
	}
	return out, nil
}

// matchParams reports whether a (light) workflow's run parameters satisfy every filter.
func matchParams(wf *wfv1.Workflow, filters []ParamFilter) bool {
	if len(filters) == 0 {
		return true
	}
	values := make(map[string]string, len(wf.Spec.Arguments.Parameters))
	for _, p := range wf.Spec.Arguments.Parameters {
		values[p.Name] = p.Value.String()
	}
	for _, f := range filters {
		v, ok := values[f.Name]
		switch {
		case !ok:
			return false
		case f.Op == "=" && v != f.Value:
			return false
		case f.Op == "~" && !strings.Contains(strings.ToLower(v), f.Value):
			return false
		}
	}
	return true
}
