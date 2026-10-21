// Package id generates the int64 primary keys of argonaut's tables.
package id

import (
	"hash/fnv"
	"os"
	"strconv"

	s1 "github.com/godruoyi/go-snowflake"
)

func init() {
	// Replicas generate ids concurrently, so each needs its own machine id; a fixed one would let two
	// replicas mint the same id in the same millisecond. The pod name (hostname) plus pid is unique per
	// process, and hashing it into the 10-bit space keeps collisions negligible at console scale.
	host, _ := os.Hostname()
	h := fnv.New32a()
	_, _ = h.Write([]byte(host + "/" + strconv.Itoa(os.Getpid())))
	s1.SetMachineID(uint16(h.Sum32() % 1024))
}

// Generate returns a time-ordered unique id.
func Generate() int64 {
	return int64(s1.ID())
}
