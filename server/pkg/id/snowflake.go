package id

import (
	s2 "github.com/bwmarrin/snowflake"
	s1 "github.com/godruoyi/go-snowflake"
)

var node *s2.Node

func init() {
	s1.SetMachineID(1)

	// node, _ = s2.NewNode(1)
}

func Generate() int64 {
	return generate1()
}

func generate1() int64 {
	return int64(s1.ID())
}

func generate2() int64 {
	return int64(node.Generate())
}
