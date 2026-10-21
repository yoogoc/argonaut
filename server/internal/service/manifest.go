package service

import (
	"fmt"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/go-kratos/kratos/v3/errors"
	"github.com/golang-jwt/jwt/v5"
	"sigs.k8s.io/yaml"
)

// The UI edits workflows, templates and cron workflows as YAML in a Monaco editor and posts the text
// verbatim. Parsing here (rather than modelling every Argo field in our own protobuf) keeps the Argo
// CRD as the single source of truth for what a manifest may contain: new Argo fields work without a
// contract change. sigs.k8s.io/yaml accepts JSON too, since JSON is valid YAML.

func parseWorkflow(manifest string) (*wfv1.Workflow, error) {
	if manifest == "" {
		return nil, errors.BadRequest("invalid_argument", "manifest is required")
	}
	wf := &wfv1.Workflow{}
	if err := yaml.UnmarshalStrict([]byte(manifest), wf); err != nil {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("not a valid Workflow: %v", err))
	}
	if wf.Kind != "" && wf.Kind != "Workflow" {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("expected kind Workflow, got %q", wf.Kind))
	}
	return wf, nil
}

func parseWorkflowTemplate(manifest string) (*wfv1.WorkflowTemplate, error) {
	if manifest == "" {
		return nil, errors.BadRequest("invalid_argument", "manifest is required")
	}
	tmpl := &wfv1.WorkflowTemplate{}
	if err := yaml.UnmarshalStrict([]byte(manifest), tmpl); err != nil {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("not a valid WorkflowTemplate: %v", err))
	}
	if tmpl.Kind != "" && tmpl.Kind != "WorkflowTemplate" {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("expected kind WorkflowTemplate, got %q", tmpl.Kind))
	}
	return tmpl, nil
}

func parseCronWorkflow(manifest string) (*wfv1.CronWorkflow, error) {
	if manifest == "" {
		return nil, errors.BadRequest("invalid_argument", "manifest is required")
	}
	cron := &wfv1.CronWorkflow{}
	if err := yaml.UnmarshalStrict([]byte(manifest), cron); err != nil {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("not a valid CronWorkflow: %v", err))
	}
	if cron.Kind != "" && cron.Kind != "CronWorkflow" {
		return nil, errors.BadRequest("invalid_manifest", fmt.Sprintf("expected kind CronWorkflow, got %q", cron.Kind))
	}
	return cron, nil
}

// jwtSubject builds the registered-claims part of a session token.
func jwtSubject(subject string) jwt.RegisteredClaims {
	return jwt.RegisteredClaims{Subject: subject}
}
