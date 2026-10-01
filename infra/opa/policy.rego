package kontrol.policy

# Generic evaluator for Kontrol control policies. It mirrors src/lib/core/policy-engine.ts operator for
# operator so OPA can cross-check any control: POST /v1/data/kontrol/policy/result
#   input: { "policy": { "all": [...], "any": [...], "none": [...] }, "facts": {...}, "now": <epoch ms> }
# Every operator fails closed: a missing fact, a wrong type or a malformed expectation never passes.

import rego.v1

missing := "__kontrol_missing__"

day_ns := 86400000000000

actual(c) := object.get(input.facts, split(c.path, "."), missing)

timestamp_ns(value) := value * 1000000 if is_number(value)

timestamp_ns(value) := time.parse_rfc3339_ns(value) if is_string(value)

now_ns := input.now * 1000000

safe_pattern(p) if {
	is_string(p)
	count(p) > 0
	count(p) <= 120
	not regex.match(`\\[1-9]`, p)
	not regex.match(`\)\s*[*+?{]`, p)
	not regex.match(`[*+?}]\s*[*+{]`, p)
	regex.is_valid(p)
}

passes(c) if {
	c.op == "eq"
	a := actual(c)
	a != missing
	a == c.value
}

passes(c) if {
	c.op == "neq"
	a := actual(c)
	a != missing
	a != c.value
}

passes(c) if {
	c.op == "gt"
	a := actual(c)
	is_number(a)
	is_number(c.value)
	a > c.value
}

passes(c) if {
	c.op == "gte"
	a := actual(c)
	is_number(a)
	is_number(c.value)
	a >= c.value
}

passes(c) if {
	c.op == "lt"
	a := actual(c)
	is_number(a)
	is_number(c.value)
	a < c.value
}

passes(c) if {
	c.op == "lte"
	a := actual(c)
	is_number(a)
	is_number(c.value)
	a <= c.value
}

passes(c) if {
	c.op == "between"
	a := actual(c)
	is_number(a)
	is_array(c.value)
	count(c.value) == 2
	is_number(c.value[0])
	is_number(c.value[1])
	a >= c.value[0]
	a <= c.value[1]
}

passes(c) if {
	c.op == "in"
	a := actual(c)
	a != missing
	is_array(c.value)
	a in c.value
}

passes(c) if {
	c.op == "not_in"
	a := actual(c)
	a != missing
	is_array(c.value)
	not a in c.value
}

passes(c) if {
	c.op == "includes"
	a := actual(c)
	is_array(a)
	c.value in a
}

passes(c) if {
	c.op == "includes"
	a := actual(c)
	a != missing
	is_string(a)
	is_string(c.value)
	contains(a, c.value)
}

passes(c) if {
	c.op == "exists"
	object.get(c, "value", true) != false
	actual(c) != missing
}

passes(c) if {
	c.op == "exists"
	object.get(c, "value", true) == false
	actual(c) == missing
}

passes(c) if {
	c.op == "not_exists"
	actual(c) == missing
}

passes(c) if {
	c.op == "length_gte"
	a := actual(c)
	a != missing
	is_number(c.value)
	count(a) >= c.value
	not is_object(a)
	not is_number(a)
	not is_boolean(a)
}

passes(c) if {
	c.op == "length_lte"
	a := actual(c)
	a != missing
	is_number(c.value)
	count(a) <= c.value
	not is_object(a)
	not is_number(a)
	not is_boolean(a)
}

passes(c) if {
	c.op == "matches"
	a := actual(c)
	a != missing
	is_string(a)
	count(a) <= 10000
	safe_pattern(c.value)
	regex.match(c.value, a)
}

passes(c) if {
	c.op == "within_days"
	at := timestamp_ns(actual(c))
	is_number(c.value)
	c.value >= 0
	at <= now_ns
	now_ns - at <= c.value * day_ns
}

passes(c) if {
	c.op == "older_than_days"
	at := timestamp_ns(actual(c))
	is_number(c.value)
	c.value >= 0
	now_ns - at > c.value * day_ns
}

ok(c) := true if passes(c)

ok(c) := false if not passes(c)

all_results := [{"condition": c, "passed": ok(c)} | some c in object.get(input.policy, "all", [])]

any_results := [{"condition": c, "passed": ok(c)} | some c in object.get(input.policy, "any", [])]

none_results := [{"condition": c, "passed": ok(c) == false} | some c in object.get(input.policy, "none", [])]

any_satisfied if count(any_results) == 0

any_satisfied if {
	some r in any_results
	r.passed
}

default passed := false

passed if {
	every r in all_results {r.passed}
	any_satisfied
	every r in none_results {r.passed}
}

result := {"passed": passed}
