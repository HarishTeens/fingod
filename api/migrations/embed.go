// Package migrations carries the SQL schema inside the binary so a deployed
// fingod can bring an empty database up to date on its own, with no psql and
// no migration framework. `make migrate` applies exactly the same files with
// exactly the same version keys, so the two paths never disagree.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
