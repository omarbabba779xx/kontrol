import { group } from "@/lib/frameworks/data/helpers";
import type { Requirement } from "@/lib/frameworks/types";

export const gdpr: Requirement[] = [
  ...group("Chapter II - Principles", `
Art.5|Principles relating to processing of personal data
Art.6|Lawfulness of processing
Art.7|Conditions for consent
Art.8|Conditions applicable to a child's consent in relation to information society services
Art.9|Processing of special categories of personal data
Art.10|Processing of personal data relating to criminal convictions and offences
Art.11|Processing which does not require identification`),
  ...group("Chapter III - Rights of the data subject", `
Art.12|Transparent information, communication and modalities
Art.13|Information to be provided where data are collected from the data subject
Art.14|Information to be provided where data have not been obtained from the data subject
Art.15|Right of access
Art.16|Right to rectification
Art.17|Right to erasure
Art.18|Right to restriction of processing
Art.19|Notification obligation regarding rectification, erasure or restriction
Art.20|Right to data portability
Art.21|Right to object
Art.22|Automated individual decision-making, including profiling`),
  ...group("Chapter IV - Controller and processor", `
Art.24|Responsibility of the controller
Art.25|Data protection by design and by default
Art.26|Joint controllers
Art.27|Representatives of controllers or processors not established in the Union
Art.28|Processor
Art.29|Processing under the authority of the controller or processor
Art.30|Records of processing activities
Art.31|Cooperation with the supervisory authority
Art.32|Security of processing
Art.33|Notification of a personal data breach to the supervisory authority
Art.34|Communication of a personal data breach to the data subject
Art.35|Data protection impact assessment
Art.36|Prior consultation
Art.37|Designation of the data protection officer
Art.38|Position of the data protection officer
Art.39|Tasks of the data protection officer
Art.40|Codes of conduct
Art.42|Certification`),
  ...group("Chapter V - International transfers", `
Art.44|General principle for transfers
Art.45|Transfers on the basis of an adequacy decision
Art.46|Transfers subject to appropriate safeguards
Art.47|Binding corporate rules
Art.48|Transfers or disclosures not authorised by Union law
Art.49|Derogations for specific situations`),
];

export const nis2: Requirement[] = [
  ...group("Article 20 - Governance", `
Art.20(1)|Management bodies approve cybersecurity risk-management measures, oversee implementation and can be held liable
Art.20(2)|Members of management bodies follow cybersecurity training`),
  ...group("Article 21 - Risk-management measures", `
Art.21(1)|Appropriate and proportionate technical, operational and organisational measures, all-hazards approach
Art.21(2)(a)|Policies on risk analysis and information system security
Art.21(2)(b)|Incident handling
Art.21(2)(c)|Business continuity, backup management, disaster recovery and crisis management
Art.21(2)(d)|Supply chain security
Art.21(2)(e)|Security in acquisition, development and maintenance, including vulnerability handling and disclosure
Art.21(2)(f)|Policies and procedures to assess the effectiveness of cybersecurity risk-management measures
Art.21(2)(g)|Basic cyber hygiene practices and cybersecurity training
Art.21(2)(h)|Policies and procedures regarding the use of cryptography and encryption
Art.21(2)(i)|Human resources security, access control policies and asset management
Art.21(2)(j)|Multi-factor or continuous authentication, secured communications and emergency communications
Art.21(3)|Take into account supplier-specific vulnerabilities and the overall quality of products and practices
Art.21(4)|Take corrective measures without undue delay when non-conformities are found`),
  ...group("Reporting and cooperation", `
Art.22|Union-level coordinated security risk assessments of critical supply chains
Art.23(1)|Notification of significant incidents to the CSIRT or competent authority
Art.23(2)|Notification of significant incidents and cyber threats to recipients of services
Art.23(4)|Early warning (24h), incident notification (72h), intermediate and final report (one month)
Art.24|Use of European cybersecurity certification schemes
Art.25|Standardisation
Art.27|Registry of entities: submission of registration information
Art.29|Cybersecurity information-sharing arrangements
Art.30|Voluntary notification of relevant information`),
];

export const dora: Requirement[] = [
  ...group("Chapter II - ICT risk management", `
Art.5|Governance and organisation
Art.6|ICT risk management framework
Art.7|ICT systems, protocols and tools
Art.8|Identification
Art.9|Protection and prevention
Art.10|Detection
Art.11|Response and recovery
Art.12|Backup policies and procedures, restoration and recovery
Art.13|Learning and evolving
Art.14|Communication
Art.15|Further harmonisation of ICT risk management tools, methods, processes and policies
Art.16|Simplified ICT risk management framework`),
  ...group("Chapter III - ICT-related incidents", `
Art.17|ICT-related incident management process
Art.18|Classification of ICT-related incidents and cyber threats
Art.19|Reporting of major ICT-related incidents and voluntary notification of significant cyber threats
Art.20|Harmonisation of reporting content and templates
Art.21|Centralisation of reporting of major ICT-related incidents
Art.22|Supervisory feedback
Art.23|Operational or security payment-related incidents`),
  ...group("Chapter IV - Digital operational resilience testing", `
Art.24|General requirements for digital operational resilience testing
Art.25|Testing of ICT tools and systems
Art.26|Advanced testing of ICT tools, systems and processes based on TLPT
Art.27|Requirements for testers for the carrying out of TLPT`),
  ...group("Chapter V - ICT third-party risk", `
Art.28|General principles for the management of ICT third-party risk
Art.28(3)|Register of information on contractual arrangements with ICT third-party service providers
Art.29|Preliminary assessment of ICT concentration risk at entity level
Art.30|Key contractual provisions`),
  ...group("Chapter VI - Information sharing", `
Art.45|Information-sharing arrangements on cyber threat information and intelligence`),
];

export const euAiAct: Requirement[] = [
  ...group("General provisions", `
Art.4|AI literacy
Art.5|Prohibited AI practices
Art.6|Classification rules for high-risk AI systems`),
  ...group("High-risk AI system requirements", `
Art.8|Compliance with the requirements for high-risk AI systems
Art.9|Risk management system
Art.10|Data and data governance
Art.11|Technical documentation
Art.12|Record-keeping
Art.13|Transparency and provision of information to deployers
Art.14|Human oversight
Art.15|Accuracy, robustness and cybersecurity`),
  ...group("Provider, deployer and value-chain obligations", `
Art.16|Obligations of providers of high-risk AI systems
Art.17|Quality management system
Art.18|Documentation keeping
Art.19|Automatically generated logs
Art.20|Corrective actions and duty of information
Art.21|Cooperation with competent authorities
Art.22|Authorised representatives of providers
Art.23|Obligations of importers
Art.24|Obligations of distributors
Art.25|Responsibilities along the AI value chain
Art.26|Obligations of deployers of high-risk AI systems
Art.27|Fundamental rights impact assessment`),
  ...group("Conformity and transparency", `
Art.43|Conformity assessment
Art.47|EU declaration of conformity
Art.48|CE marking
Art.49|Registration
Art.50|Transparency obligations for providers and deployers of certain AI systems`),
  ...group("General-purpose AI models", `
Art.51|Classification of general-purpose AI models as general-purpose AI models with systemic risk
Art.53|Obligations for providers of general-purpose AI models
Art.55|Obligations for providers of general-purpose AI models with systemic risk`),
  ...group("Monitoring and remedies", `
Art.72|Post-market monitoring by providers
Art.73|Reporting of serious incidents
Art.86|Right to explanation of individual decision-making`),
];
