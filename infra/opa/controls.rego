package kontrol.controls
import rego.v1
default allow := false
allow if {
  input.production == true
  input.branchProtection.enabled == true
  input.branchProtection.requiredReviews >= 1
}
violations contains "production branch is not protected" if input.production == true
violations contains "at least one independent review is required" if input.branchProtection.requiredReviews < 1
result := {"passed": allow, "violations": violations, "control": "CTL-SDLC-004"}
