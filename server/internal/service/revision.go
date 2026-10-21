package service

import (
	"context"
	"strconv"

	v1 "argonaut/api/v1"
	"argonaut/internal/biz"

	"github.com/go-kratos/kratos/v3/transport"
)

func toProtoRevision(r biz.TemplateRevision) *v1.TemplateRevision {
	return &v1.TemplateRevision{
		Id: r.ID, Seq: int32(r.Seq), ResourceVersion: r.ResourceVersion, Author: r.Author, External: r.External,
		Message: r.Message, CreatedAt: r.CreatedAt.UTC().Format(timeFormat), Manifest: string(r.Manifest),
	}
}

func toProtoRevisions(revs []biz.TemplateRevision) *v1.TemplateRevisionsReply {
	reply := &v1.TemplateRevisionsReply{}
	for _, r := range revs {
		reply.Revisions = append(reply.Revisions, toProtoRevision(r))
	}
	return reply
}

// setRevisionHeader reports the authorization revision a write produced, so the client can send it
// back and get read-your-writes on any replica (DESIGN §4.3).
func setRevisionHeader(ctx context.Context, rev int64) {
	if tr, ok := transport.FromServerContext(ctx); ok && rev > 0 {
		tr.ReplyHeader().Set(RevisionHeader, strconv.FormatInt(rev, 10))
	}
}

// RevisionHeader carries authorization revisions between client and server.
const RevisionHeader = "X-Authz-Revision"
