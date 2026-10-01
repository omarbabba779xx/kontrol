import { group } from "@/lib/frameworks/data/helpers";
import type { Requirement, RequirementGroup } from "@/lib/frameworks/types";

const parentByPrefix = (separator: string, depth: number) => (id: string) => id.split(separator).slice(0, depth).join(separator);

/** Builds requirements from "id|title" lines and pairs them with their parent group title. */
function section(groups: RequirementGroup[], lines: string, parentOf: (id: string) => string): Requirement[] {
  const titles = new Map(groups.map((item) => [item.id, item.title]));
  return group("", lines, parentOf).map((requirement) => ({ ...requirement, group: `${requirement.parent} ${titles.get(requirement.parent!) ?? ""}`.trim() }));
}

// ISO/IEC 42001:2023 -----------------------------------------------------------------------------
export const ISO42001_GROUPS: RequirementGroup[] = [
  { id: "A2", title: "Policies related to AI" }, { id: "A3", title: "Internal organization" }, { id: "A4", title: "Resources for AI systems" },
  { id: "A5", title: "Assessing impacts of AI systems" }, { id: "A6", title: "AI system life cycle" }, { id: "A7", title: "Data for AI systems" },
  { id: "A8", title: "Information for interested parties of AI systems" }, { id: "A9", title: "Use of AI systems" }, { id: "A10", title: "Third-party and customer relationships" },
];

export const ISO42001_REQUIREMENTS: Requirement[] = [
  ...group("AIMS clauses", `
C4.1|Understanding the organization and its context
C4.2|Understanding the needs and expectations of interested parties
C4.3|Determining the scope of the AI management system
C4.4|AI management system
C5.1|Leadership and commitment
C5.2|AI policy
C5.3|Roles, responsibilities and authorities
C6.1|Actions to address risks and opportunities
C6.2|AI objectives and planning to achieve them
C6.3|Planning of changes
C7.1|Resources
C7.2|Competence
C7.3|Awareness
C7.4|Communication
C7.5|Documented information
C8.1|Operational planning and control
C8.2|AI risk assessment
C8.3|AI risk treatment
C8.4|AI system impact assessment
C9.1|Monitoring, measurement, analysis and evaluation
C9.2|Internal audit
C9.3|Management review
C10.1|Continual improvement
C10.2|Nonconformity and corrective action`),
  ...section(ISO42001_GROUPS, `
A.2.2|AI policy
A.2.3|Alignment with other organizational policies
A.2.4|Review of the AI policy
A.3.2|AI roles and responsibilities
A.3.3|Reporting of concerns
A.4.2|Resource documentation
A.4.3|Data resources
A.4.4|Tooling resources
A.4.5|System and computing resources
A.4.6|Human resources
A.5.2|AI system impact assessment process
A.5.3|Documentation of AI system impact assessments
A.5.4|Assessment of AI system impact on individuals or groups of individuals
A.5.5|Assessment of societal impacts of AI systems
A.6.1.2|Objectives for responsible development of AI system
A.6.1.3|Processes for responsible design and development of AI systems
A.6.2.2|AI system requirements and specification
A.6.2.3|Documentation of AI system design and development
A.6.2.4|AI system verification and validation
A.6.2.5|AI system deployment
A.6.2.6|AI system operation and monitoring
A.6.2.7|AI system technical documentation
A.6.2.8|AI system recording of event logs
A.7.2|Data for development and enhancement of AI system
A.7.3|Acquisition of data
A.7.4|Quality of data for AI systems
A.7.5|Data provenance
A.7.6|Data preparation
A.8.2|System documentation and information for users
A.8.3|External reporting
A.8.4|Communication of incidents
A.8.5|Information for interested parties
A.9.2|Processes for responsible use of AI systems
A.9.3|Objectives for responsible use of AI system
A.9.4|Intended use of the AI system
A.10.2|Allocating responsibilities
A.10.3|Suppliers
A.10.4|Customers`, (id) => `A${id.split(".")[1]}`),
];

// PCI DSS v4.0.1 ---------------------------------------------------------------------------------
export const PCI_GROUPS: RequirementGroup[] = [
  { id: "Req.1", title: "Install and maintain network security controls" }, { id: "Req.2", title: "Apply secure configurations to all system components" },
  { id: "Req.3", title: "Protect stored account data" }, { id: "Req.4", title: "Protect cardholder data with strong cryptography during transmission" },
  { id: "Req.5", title: "Protect all systems and networks from malicious software" }, { id: "Req.6", title: "Develop and maintain secure systems and software" },
  { id: "Req.7", title: "Restrict access by business need to know" }, { id: "Req.8", title: "Identify users and authenticate access" },
  { id: "Req.9", title: "Restrict physical access to cardholder data" }, { id: "Req.10", title: "Log and monitor all access" },
  { id: "Req.11", title: "Test security of systems and networks regularly" }, { id: "Req.12", title: "Support information security with organizational policies and programs" },
];

/** Section level (x.y). The testing procedures below this level are licensed PCI SSC content and are not reproduced. */
export const PCI_REQUIREMENTS: Requirement[] = section(PCI_GROUPS, `
Req.1.1|Network security control processes and mechanisms are defined and understood
Req.1.2|Network security controls are configured and maintained
Req.1.3|Network access to and from the cardholder data environment is restricted
Req.1.4|Connections between trusted and untrusted networks are controlled
Req.1.5|Risks from devices connecting to both untrusted networks and the CDE are mitigated
Req.2.1|Secure configuration processes and mechanisms are defined and understood
Req.2.2|System components are configured and managed securely
Req.2.3|Wireless environments are configured and managed securely
Req.3.1|Processes for protecting stored account data are defined and understood
Req.3.2|Storage of account data is kept to a minimum
Req.3.3|Sensitive authentication data is not stored after authorization
Req.3.4|Access to displays of full PAN and ability to copy PAN is restricted
Req.3.5|PAN is secured wherever it is stored
Req.3.6|Cryptographic keys protecting stored account data are secured
Req.3.7|Key-management processes cover the whole key lifecycle
Req.4.1|Processes for protecting cardholder data in transit are defined and documented
Req.4.2|PAN is protected with strong cryptography during transmission
Req.5.1|Anti-malware processes and mechanisms are defined and understood
Req.5.2|Malicious software is prevented, or detected and addressed
Req.5.3|Anti-malware mechanisms and processes are active, maintained and monitored
Req.5.4|Anti-phishing mechanisms protect users against phishing attacks
Req.6.1|Secure development and maintenance processes are defined and understood
Req.6.2|Bespoke and custom software is developed securely
Req.6.3|Security vulnerabilities are identified and addressed
Req.6.4|Public-facing web applications are protected against attacks
Req.6.5|Changes to all system components are managed securely
Req.7.1|Access restriction processes and mechanisms are defined and understood
Req.7.2|Access to system components and data is appropriately defined and assigned
Req.7.3|Access to system components and data is managed via an access control system
Req.8.1|User identification and authentication processes are defined and understood
Req.8.2|User identification and related accounts are strictly managed through their lifecycle
Req.8.3|Strong authentication for users and administrators is established and managed
Req.8.4|Multi-factor authentication secures access into the CDE
Req.8.5|Multi-factor authentication systems are configured to prevent misuse
Req.8.6|Use of application and system accounts is strictly managed
Req.9.1|Physical access restriction processes are defined and understood
Req.9.2|Physical access controls manage entry into facilities and systems
Req.9.3|Physical access for personnel and visitors is authorized and managed
Req.9.4|Media with cardholder data is securely stored, accessed, distributed and destroyed
Req.9.5|Point-of-interaction devices are protected from tampering and substitution
Req.10.1|Logging and monitoring processes are defined and documented
Req.10.2|Audit logs support anomaly detection and forensic analysis
Req.10.3|Audit logs are protected from destruction and unauthorized modification
Req.10.4|Audit logs are reviewed to identify anomalies or suspicious activity
Req.10.5|Audit log history is retained and available for analysis
Req.10.6|Time-synchronization mechanisms support consistent time settings
Req.10.7|Failures of critical security control systems are detected, reported and responded to
Req.11.1|Security testing processes and mechanisms are defined and understood
Req.11.2|Wireless access points are identified and monitored
Req.11.3|External and internal vulnerabilities are regularly identified, prioritized and addressed
Req.11.4|External and internal penetration testing is regularly performed
Req.11.5|Network intrusions and unexpected file changes are detected and responded to
Req.11.6|Unauthorized changes on payment pages are detected and responded to
Req.12.1|A comprehensive information security policy is known and current
Req.12.2|Acceptable use policies for end-user technologies are defined and implemented
Req.12.3|Risks to the cardholder data environment are formally identified, evaluated and managed
Req.12.4|PCI DSS compliance is managed
Req.12.5|PCI DSS scope is documented and validated
Req.12.6|Security awareness education is an ongoing activity
Req.12.7|Personnel are screened to reduce insider-threat risks
Req.12.8|Risk from third-party service provider relationships is managed
Req.12.9|Third-party service providers support their customers' PCI DSS compliance
Req.12.10|Suspected and confirmed security incidents are responded to immediately`, parentByPrefix(".", 2));

// CIS Critical Security Controls v8 ---------------------------------------------------------------
export const CIS_GROUPS: RequirementGroup[] = [
  { id: "CIS.1", title: "Inventory and Control of Enterprise Assets" }, { id: "CIS.2", title: "Inventory and Control of Software Assets" },
  { id: "CIS.3", title: "Data Protection" }, { id: "CIS.4", title: "Secure Configuration of Enterprise Assets and Software" },
  { id: "CIS.5", title: "Account Management" }, { id: "CIS.6", title: "Access Control Management" },
  { id: "CIS.7", title: "Continuous Vulnerability Management" }, { id: "CIS.8", title: "Audit Log Management" },
  { id: "CIS.9", title: "Email and Web Browser Protections" }, { id: "CIS.10", title: "Malware Defenses" },
  { id: "CIS.11", title: "Data Recovery" }, { id: "CIS.12", title: "Network Infrastructure Management" },
  { id: "CIS.13", title: "Network Monitoring and Defense" }, { id: "CIS.14", title: "Security Awareness and Skills Training" },
  { id: "CIS.15", title: "Service Provider Management" }, { id: "CIS.16", title: "Application Software Security" },
  { id: "CIS.17", title: "Incident Response Management" }, { id: "CIS.18", title: "Penetration Testing" },
];

/** All 153 safeguards of CIS Controls v8. */
export const CIS_REQUIREMENTS: Requirement[] = section(CIS_GROUPS, `
CIS.1.1|Establish and maintain a detailed enterprise asset inventory
CIS.1.2|Address unauthorized assets
CIS.1.3|Utilize an active discovery tool
CIS.1.4|Use DHCP logging to update the enterprise asset inventory
CIS.1.5|Use a passive asset discovery tool
CIS.2.1|Establish and maintain a software inventory
CIS.2.2|Ensure authorized software is currently supported
CIS.2.3|Address unauthorized software
CIS.2.4|Utilize automated software inventory tools
CIS.2.5|Allowlist authorized software
CIS.2.6|Allowlist authorized libraries
CIS.2.7|Allowlist authorized scripts
CIS.3.1|Establish and maintain a data management process
CIS.3.2|Establish and maintain a data inventory
CIS.3.3|Configure data access control lists
CIS.3.4|Enforce data retention
CIS.3.5|Securely dispose of data
CIS.3.6|Encrypt data on end-user devices
CIS.3.7|Establish and maintain a data classification scheme
CIS.3.8|Document data flows
CIS.3.9|Encrypt data on removable media
CIS.3.10|Encrypt sensitive data in transit
CIS.3.11|Encrypt sensitive data at rest
CIS.3.12|Segment data processing and storage based on sensitivity
CIS.3.13|Deploy a data loss prevention solution
CIS.3.14|Log sensitive data access
CIS.4.1|Establish and maintain a secure configuration process
CIS.4.2|Establish and maintain a secure configuration process for network infrastructure
CIS.4.3|Configure automatic session locking on enterprise assets
CIS.4.4|Implement and manage a firewall on servers
CIS.4.5|Implement and manage a firewall on end-user devices
CIS.4.6|Securely manage enterprise assets and software
CIS.4.7|Manage default accounts on enterprise assets and software
CIS.4.8|Uninstall or disable unnecessary services
CIS.4.9|Configure trusted DNS servers on enterprise assets
CIS.4.10|Enforce automatic device lockout on portable end-user devices
CIS.4.11|Enforce remote wipe capability on portable end-user devices
CIS.4.12|Separate enterprise workspaces on mobile end-user devices
CIS.5.1|Establish and maintain an inventory of accounts
CIS.5.2|Use unique passwords
CIS.5.3|Disable dormant accounts
CIS.5.4|Restrict administrator privileges to dedicated administrator accounts
CIS.5.5|Establish and maintain an inventory of service accounts
CIS.5.6|Centralize account management
CIS.6.1|Establish an access granting process
CIS.6.2|Establish an access revoking process
CIS.6.3|Require MFA for externally-exposed applications
CIS.6.4|Require MFA for remote network access
CIS.6.5|Require MFA for administrative access
CIS.6.6|Establish and maintain an inventory of authentication and authorization systems
CIS.6.7|Centralize access control
CIS.6.8|Define and maintain role-based access control
CIS.7.1|Establish and maintain a vulnerability management process
CIS.7.2|Establish and maintain a remediation process
CIS.7.3|Perform automated operating system patch management
CIS.7.4|Perform automated application patch management
CIS.7.5|Perform automated vulnerability scans of internal enterprise assets
CIS.7.6|Perform automated vulnerability scans of externally-exposed enterprise assets
CIS.7.7|Remediate detected vulnerabilities
CIS.8.1|Establish and maintain an audit log management process
CIS.8.2|Collect audit logs
CIS.8.3|Ensure adequate audit log storage
CIS.8.4|Standardize time synchronization
CIS.8.5|Collect detailed audit logs
CIS.8.6|Collect DNS query audit logs
CIS.8.7|Collect URL request audit logs
CIS.8.8|Collect command-line audit logs
CIS.8.9|Centralize audit logs
CIS.8.10|Retain audit logs
CIS.8.11|Conduct audit log reviews
CIS.8.12|Collect service provider logs
CIS.9.1|Ensure use of only fully supported browsers and email clients
CIS.9.2|Use DNS filtering services
CIS.9.3|Maintain and enforce network-based URL filters
CIS.9.4|Restrict unnecessary or unauthorized browser and email client extensions
CIS.9.5|Implement DMARC
CIS.9.6|Block unnecessary file types
CIS.9.7|Deploy and maintain email server anti-malware protections
CIS.10.1|Deploy and maintain anti-malware software
CIS.10.2|Configure automatic anti-malware signature updates
CIS.10.3|Disable autorun and autoplay for removable media
CIS.10.4|Configure automatic anti-malware scanning of removable media
CIS.10.5|Enable anti-exploitation features
CIS.10.6|Centrally manage anti-malware software
CIS.10.7|Use behavior-based anti-malware software
CIS.11.1|Establish and maintain a data recovery process
CIS.11.2|Perform automated backups
CIS.11.3|Protect recovery data
CIS.11.4|Establish and maintain an isolated instance of recovery data
CIS.11.5|Test data recovery
CIS.12.1|Ensure network infrastructure is up-to-date
CIS.12.2|Establish and maintain a secure network architecture
CIS.12.3|Securely manage network infrastructure
CIS.12.4|Establish and maintain architecture diagrams
CIS.12.5|Centralize network authentication, authorization and auditing (AAA)
CIS.12.6|Use secure network management and communication protocols
CIS.12.7|Ensure remote devices use a VPN and connect to the enterprise AAA infrastructure
CIS.12.8|Establish and maintain dedicated computing resources for administrative work
CIS.13.1|Centralize security event alerting
CIS.13.2|Deploy a host-based intrusion detection solution
CIS.13.3|Deploy a network intrusion detection solution
CIS.13.4|Perform traffic filtering between network segments
CIS.13.5|Manage access control for remote assets
CIS.13.6|Collect network traffic flow logs
CIS.13.7|Deploy a host-based intrusion prevention solution
CIS.13.8|Deploy a network intrusion prevention solution
CIS.13.9|Deploy port-level access control
CIS.13.10|Perform application layer filtering
CIS.13.11|Tune security event alerting thresholds
CIS.14.1|Establish and maintain a security awareness program
CIS.14.2|Train workforce members to recognize social engineering attacks
CIS.14.3|Train workforce members on authentication best practices
CIS.14.4|Train workforce on data handling best practices
CIS.14.5|Train workforce members on causes of unintentional data exposure
CIS.14.6|Train workforce members on recognizing and reporting security incidents
CIS.14.7|Train workforce on how to identify and report missing security updates
CIS.14.8|Train workforce on the dangers of insecure networks
CIS.14.9|Conduct role-specific security awareness and skills training
CIS.15.1|Establish and maintain an inventory of service providers
CIS.15.2|Establish and maintain a service provider management policy
CIS.15.3|Classify service providers
CIS.15.4|Ensure service provider contracts include security requirements
CIS.15.5|Assess service providers
CIS.15.6|Monitor service providers
CIS.15.7|Securely decommission service providers
CIS.16.1|Establish and maintain a secure application development process
CIS.16.2|Establish and maintain a process to accept and address software vulnerabilities
CIS.16.3|Perform root cause analysis on security vulnerabilities
CIS.16.4|Establish and manage an inventory of third-party software components
CIS.16.5|Use up-to-date and trusted third-party software components
CIS.16.6|Establish and maintain a severity rating system for application vulnerabilities
CIS.16.7|Use standard hardening configuration templates for application infrastructure
CIS.16.8|Separate production and non-production systems
CIS.16.9|Train developers in application security concepts and secure coding
CIS.16.10|Apply secure design principles in application architectures
CIS.16.11|Leverage vetted modules or services for application security components
CIS.16.12|Implement code-level security checks
CIS.16.13|Conduct application penetration testing
CIS.16.14|Conduct threat modeling
CIS.17.1|Designate personnel to manage incident handling
CIS.17.2|Establish and maintain contact information for reporting security incidents
CIS.17.3|Establish and maintain an enterprise process for reporting incidents
CIS.17.4|Establish and maintain an incident response process
CIS.17.5|Assign key roles and responsibilities
CIS.17.6|Define mechanisms for communicating during incident response
CIS.17.7|Conduct routine incident response exercises
CIS.17.8|Conduct post-incident reviews
CIS.17.9|Establish and maintain security incident thresholds
CIS.18.1|Establish and maintain a penetration testing program
CIS.18.2|Perform periodic external penetration tests
CIS.18.3|Remediate penetration test findings
CIS.18.4|Validate security measures
CIS.18.5|Perform periodic internal penetration tests`, parentByPrefix(".", 2));
