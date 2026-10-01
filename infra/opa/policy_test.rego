package kontrol.policy_test

import rego.v1

verdict(p) := v if {
	v := data.kontrol.policy.result with input as {"policy": p, "facts": facts, "now": now_ms}
}

facts := {"a": {"n": 5, "s": "hello", "list": ["x", "y"], "when": "2026-01-10T00:00:00Z"}}

now_ms := 1768435200000 # 2026-01-15T00:00:00Z


test_eq_passes if verdict({"all": [{"path": "a.n", "op": "eq", "value": 5}]}).passed

test_missing_fact_never_passes if not verdict({"all": [{"path": "a.zzz", "op": "eq", "value": 5}]}).passed

test_missing_fact_neq_fails_closed if not verdict({"all": [{"path": "a.zzz", "op": "neq", "value": 5}]}).passed

test_type_mismatch_fails_closed if not verdict({"all": [{"path": "a.s", "op": "gte", "value": 1}]}).passed

test_between if verdict({"all": [{"path": "a.n", "op": "between", "value": [1, 5]}]}).passed

test_in_and_not_in if {
	verdict({"all": [{"path": "a.s", "op": "in", "value": ["hello", "x"]}]}).passed
	verdict({"all": [{"path": "a.s", "op": "not_in", "value": ["nope"]}]}).passed
}

test_any_group if {
	verdict({"any": [{"path": "a.n", "op": "gt", "value": 9}, {"path": "a.n", "op": "lt", "value": 9}]}).passed
	not verdict({"any": [{"path": "a.n", "op": "gt", "value": 9}, {"path": "a.n", "op": "lt", "value": 1}]}).passed
}

test_none_group if {
	verdict({"none": [{"path": "a.n", "op": "gt", "value": 9}]}).passed
	not verdict({"none": [{"path": "a.n", "op": "eq", "value": 5}]}).passed
}

test_length_and_includes if {
	verdict({"all": [{"path": "a.list", "op": "length_gte", "value": 2}, {"path": "a.list", "op": "includes", "value": "y"}]}).passed
	not verdict({"all": [{"path": "a.n", "op": "length_gte", "value": 1}]}).passed
}

test_exists_variants if {
	verdict({"all": [{"path": "a.n", "op": "exists"}, {"path": "a.zzz", "op": "not_exists"}, {"path": "a.zzz", "op": "exists", "value": false}]}).passed
}

test_matches_and_unsafe_patterns if {
	verdict({"all": [{"path": "a.s", "op": "matches", "value": "^he"}]}).passed
	not verdict({"all": [{"path": "a.s", "op": "matches", "value": "(a+)+$"}]}).passed
	not verdict({"all": [{"path": "a.s", "op": "matches", "value": "(h)\\1"}]}).passed
}

test_recency_operators if {
	verdict({"all": [{"path": "a.when", "op": "within_days", "value": 7}]}).passed
	not verdict({"all": [{"path": "a.when", "op": "within_days", "value": 2}]}).passed
	verdict({"all": [{"path": "a.when", "op": "older_than_days", "value": 2}]}).passed
}
