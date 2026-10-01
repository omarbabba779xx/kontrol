import { CSF_CATEGORIES, CSF_FUNCTIONS, CSF_SUBCATEGORIES } from "@/lib/frameworks/data/csf-data";
import { CIS_GROUPS, CIS_REQUIREMENTS, ISO42001_GROUPS, ISO42001_REQUIREMENTS, PCI_GROUPS, PCI_REQUIREMENTS } from "@/lib/frameworks/data/standards";
import { dora, euAiAct, gdpr, nis2 } from "@/lib/frameworks/data/regulations";
import { group } from "@/lib/frameworks/data/helpers";
import type { Framework, Requirement } from "@/lib/frameworks/types";

const nistCsf: Requirement[] = CSF_SUBCATEGORIES.map(([id, title]) => {
  const parent = id.split("-")[0];
  const category = CSF_CATEGORIES.find((item) => item.id === parent)!;
  return { id, title, group: `${CSF_FUNCTIONS[parent.split(".")[0]]} · ${category.id} ${category.title}`, parent };
});

const iso27001: Requirement[] = [
  ...group("ISMS clauses", `
C4.1|Understanding the organization and its context
C4.2|Understanding the needs and expectations of interested parties
C4.3|Determining the scope of the ISMS
C4.4|Information security management system
C5.1|Leadership and commitment
C5.2|Information security policy
C5.3|Organizational roles, responsibilities and authorities
C6.1|Actions to address risks and opportunities
C6.2|Information security objectives and planning to achieve them
C6.3|Planning of changes
C7.1|Resources
C7.2|Competence
C7.3|Awareness
C7.4|Communication
C7.5|Documented information
C8.1|Operational planning and control
C8.2|Information security risk assessment
C8.3|Information security risk treatment
C9.1|Monitoring, measurement, analysis and evaluation
C9.2|Internal audit
C9.3|Management review
C10.1|Continual improvement
C10.2|Nonconformity and corrective action`),
  ...group("Organizational controls", `
A5.1|Policies for information security
A5.2|Information security roles and responsibilities
A5.3|Segregation of duties
A5.4|Management responsibilities
A5.5|Contact with authorities
A5.6|Contact with special interest groups
A5.7|Threat intelligence
A5.8|Information security in project management
A5.9|Inventory of information and other associated assets
A5.10|Acceptable use of information and other associated assets
A5.11|Return of assets
A5.12|Classification of information
A5.13|Labelling of information
A5.14|Information transfer
A5.15|Access control
A5.16|Identity management
A5.17|Authentication information
A5.18|Access rights
A5.19|Information security in supplier relationships
A5.20|Addressing information security within supplier agreements
A5.21|Managing information security in the ICT supply chain
A5.22|Monitoring, review and change management of supplier services
A5.23|Information security for use of cloud services
A5.24|Incident management planning and preparation
A5.25|Assessment and decision on information security events
A5.26|Response to information security incidents
A5.27|Learning from information security incidents
A5.28|Collection of evidence
A5.29|Information security during disruption
A5.30|ICT readiness for business continuity
A5.31|Legal, statutory, regulatory and contractual requirements
A5.32|Intellectual property rights
A5.33|Protection of records
A5.34|Privacy and protection of PII
A5.35|Independent review of information security
A5.36|Compliance with policies, rules and standards
A5.37|Documented operating procedures`),
  ...group("People controls", `
A6.1|Screening
A6.2|Terms and conditions of employment
A6.3|Information security awareness, education and training
A6.4|Disciplinary process
A6.5|Responsibilities after termination or change of employment
A6.6|Confidentiality or non-disclosure agreements
A6.7|Remote working
A6.8|Information security event reporting`),
  ...group("Physical controls", `
A7.1|Physical security perimeters
A7.2|Physical entry
A7.3|Securing offices, rooms and facilities
A7.4|Physical security monitoring
A7.5|Protecting against physical and environmental threats
A7.6|Working in secure areas
A7.7|Clear desk and clear screen
A7.8|Equipment siting and protection
A7.9|Security of assets off-premises
A7.10|Storage media
A7.11|Supporting utilities
A7.12|Cabling security
A7.13|Equipment maintenance
A7.14|Secure disposal or re-use of equipment`),
  ...group("Technological controls", `
A8.1|User endpoint devices
A8.2|Privileged access rights
A8.3|Information access restriction
A8.4|Access to source code
A8.5|Secure authentication
A8.6|Capacity management
A8.7|Protection against malware
A8.8|Management of technical vulnerabilities
A8.9|Configuration management
A8.10|Information deletion
A8.11|Data masking
A8.12|Data leakage prevention
A8.13|Information backup
A8.14|Redundancy of information processing facilities
A8.15|Logging
A8.16|Monitoring activities
A8.17|Clock synchronization
A8.18|Use of privileged utility programs
A8.19|Installation of software on operational systems
A8.20|Networks security
A8.21|Security of network services
A8.22|Segregation of networks
A8.23|Web filtering
A8.24|Use of cryptography
A8.25|Secure development life cycle
A8.26|Application security requirements
A8.27|Secure system architecture and engineering principles
A8.28|Secure coding
A8.29|Security testing in development and acceptance
A8.30|Outsourced development
A8.31|Separation of development, test and production environments
A8.32|Change management
A8.33|Test information
A8.34|Protection of information systems during audit testing`),
];

const soc2: Requirement[] = [
  ...group("Control environment (CC1)", `
CC1.1|Commitment to integrity and ethical values
CC1.2|Board independence and oversight
CC1.3|Structures, reporting lines and authorities
CC1.4|Commitment to attract, develop and retain competent people
CC1.5|Accountability for internal control responsibilities`),
  ...group("Communication and information (CC2)", `
CC2.1|Use of relevant, quality information
CC2.2|Internal communication of control information
CC2.3|Communication with external parties`),
  ...group("Risk assessment (CC3)", `
CC3.1|Specification of suitable objectives
CC3.2|Risk identification and analysis
CC3.3|Consideration of fraud risk
CC3.4|Identification and assessment of significant change`),
  ...group("Monitoring activities (CC4)", `
CC4.1|Ongoing and separate evaluations
CC4.2|Evaluation and communication of deficiencies`),
  ...group("Control activities (CC5)", `
CC5.1|Selection and development of control activities
CC5.2|General controls over technology
CC5.3|Deployment through policies and procedures`),
  ...group("Logical and physical access (CC6)", `
CC6.1|Logical access security software, infrastructure and architectures
CC6.2|User registration and authorization
CC6.3|Role-based access and least privilege
CC6.4|Physical access restrictions
CC6.5|Disposal of assets and data
CC6.6|Protection against threats from outside system boundaries
CC6.7|Restriction of data transmission, movement and removal
CC6.8|Prevention and detection of malicious software`),
  ...group("System operations (CC7)", `
CC7.1|Detection of configuration changes and vulnerabilities
CC7.2|Monitoring for anomalies
CC7.3|Evaluation of security events
CC7.4|Incident response
CC7.5|Recovery from incidents`),
  ...group("Change management (CC8)", `
CC8.1|Authorization, testing and approval of changes`),
  ...group("Risk mitigation (CC9)", `
CC9.1|Mitigation of business disruption risk
CC9.2|Vendor and business partner risk management`),
  ...group("Availability", `
A1.1|Capacity management
A1.2|Environmental protections, backup and recovery infrastructure
A1.3|Recovery plan testing`),
  ...group("Confidentiality", `
C1.1|Identification and protection of confidential information
C1.2|Disposal of confidential information`),
  ...group("Processing integrity", `
PI1.1|Definition of processing objectives and specifications
PI1.2|Input completeness and accuracy
PI1.3|Processing completeness, accuracy and timeliness
PI1.4|Output completeness and accuracy
PI1.5|Storage of processed data`),
  ...group("Privacy", `
P1|Notice and communication of objectives
P2|Choice and consent
P3|Collection
P4|Use, retention and disposal
P5|Access
P6|Disclosure and notification
P7|Quality
P8|Monitoring and enforcement`),
];

export const FRAMEWORKS: Framework[] = [
  { id: "iso27001", name: "ISO/IEC 27001", version: "2022", authority: "ISO/IEC", kind: "standard", granularity: "Complete: clauses 4-10 and all 93 Annex A controls", sourceUrl: "https://www.iso.org/standard/27001", requirements: iso27001 },
  { id: "nist_csf", name: "NIST Cybersecurity Framework", version: "2.0", authority: "NIST", kind: "framework", granularity: "Complete: all 106 subcategories in 22 categories (official NIST reference data)", sourceUrl: "https://doi.org/10.6028/NIST.CSWP.29", groups: CSF_CATEGORIES, requirements: nistCsf },
  { id: "soc2", name: "SOC 2 Trust Services Criteria", version: "2017 (rev. 2022)", authority: "AICPA", kind: "framework", granularity: "Complete at criterion level: CC1-CC9, Availability, Confidentiality, Processing Integrity, Privacy", sourceUrl: "https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services", requirements: soc2 },
  { id: "gdpr", name: "GDPR", version: "Regulation (EU) 2016/679", authority: "European Union", kind: "regulation", granularity: "All 42 operational articles of Chapters II-V", sourceUrl: "https://eur-lex.europa.eu/eli/reg/2016/679/oj", requirements: gdpr },
  { id: "nis2", name: "NIS2 Directive", version: "Directive (EU) 2022/2555", authority: "European Union", kind: "regulation", granularity: "Entity obligations: Articles 20-25, 27, 29, 30 with every Art. 21(2) measure", sourceUrl: "https://eur-lex.europa.eu/eli/dir/2022/2555/oj", requirements: nis2 },
  { id: "dora", name: "DORA", version: "Regulation (EU) 2022/2554", authority: "European Union", kind: "regulation", granularity: "Entity obligations: Articles 5-30 and 45", sourceUrl: "https://eur-lex.europa.eu/eli/reg/2022/2554/oj", requirements: dora },
  { id: "eu_ai_act", name: "EU AI Act", version: "Regulation (EU) 2024/1689", authority: "European Union", kind: "regulation", granularity: "34 articles: high-risk requirements, value-chain duties, GPAI, monitoring", sourceUrl: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj", requirements: euAiAct },
  { id: "iso42001", name: "ISO/IEC 42001", version: "2023", authority: "ISO/IEC", kind: "standard", granularity: "Complete: clauses 4-10 and all 38 Annex A controls", sourceUrl: "https://www.iso.org/standard/81230.html", groups: ISO42001_GROUPS, requirements: ISO42001_REQUIREMENTS },
  { id: "pci_dss", name: "PCI DSS", version: "4.0.1", authority: "PCI SSC", kind: "standard", granularity: "12 requirements and 63 sections (x.y). Testing procedures are licensed content and are not reproduced", sourceUrl: "https://www.pcisecuritystandards.org/", groups: PCI_GROUPS, requirements: PCI_REQUIREMENTS },
  { id: "cis_v8", name: "CIS Critical Security Controls", version: "8", authority: "Center for Internet Security", kind: "framework", granularity: "Complete: all 18 controls and 153 safeguards", sourceUrl: "https://www.cisecurity.org/controls", groups: CIS_GROUPS, requirements: CIS_REQUIREMENTS },
];

export const FRAMEWORK_BY_ID = new Map(FRAMEWORKS.map((framework) => [framework.id, framework]));
