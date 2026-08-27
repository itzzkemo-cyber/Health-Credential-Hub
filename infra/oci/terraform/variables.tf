variable "tenancy_id" {
  description = "OCI tenancy OCID; used for AD discovery and tenancy IAM policies."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ocid1\\.tenancy\\.oc1\\.\\.[A-Za-z0-9]+$", var.tenancy_id))
    error_message = "tenancy_id must be an OCI tenancy OCID."
  }
}

variable "deployment_profile" {
  description = "Safety selector. This stack contains paid managed resources and is disabled by default."
  type        = string
  default     = "FREE_ACCEPTANCE"

  validation {
    condition     = contains(["FREE_ACCEPTANCE", "PAID_PRODUCTION"], var.deployment_profile)
    error_message = "deployment_profile must be FREE_ACCEPTANCE or PAID_PRODUCTION."
  }
}

variable "confirm_paid_production" {
  description = "Separate deliberate confirmation required before this paid reference stack can be planned or applied."
  type        = string
  default     = ""
  sensitive   = true
}

variable "compartment_id" {
  description = "Dedicated production compartment OCID."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ocid1\\.compartment\\.oc1\\.\\.[A-Za-z0-9]+$", var.compartment_id))
    error_message = "compartment_id must be an OCI compartment OCID."
  }
}

variable "region" {
  description = "Reviewed Saudi Arabia Central (Riyadh) region."
  type        = string
  default     = "me-riyadh-1"

  validation {
    condition     = var.region == "me-riyadh-1"
    error_message = "Production is restricted to me-riyadh-1."
  }
}

variable "availability_domain" {
  description = "Optional exact Riyadh AD name; first visible AD is used when null."
  type        = string
  default     = null
  nullable    = true
}

variable "name_prefix" {
  description = "Non-sensitive prefix for OCI resource names."
  type        = string
  default     = "wathaiqi-health"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name_prefix))
    error_message = "name_prefix must be 3-30 lowercase letters, digits, or hyphens."
  }
}

variable "public_hostname" {
  description = "Canonical public application hostname."
  type        = string
  default     = "app.wathaiqihealth.com"

  validation {
    condition     = var.public_hostname == "app.wathaiqihealth.com"
    error_message = "The reviewed production hostname is app.wathaiqihealth.com."
  }
}

variable "tls_certificate_id" {
  description = "Riyadh OCI Certificates certificate OCID; private key never enters Terraform."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ocid1\\.certificate\\.oc1\\.me-riyadh-1\\.[A-Za-z0-9.]+$", var.tls_certificate_id))
    error_message = "tls_certificate_id must be a Riyadh OCI Certificates certificate OCID."
  }
}

variable "db_admin_username" {
  description = "PostgreSQL bootstrap administrator; never use as the app role."
  type        = string
  default     = "healthdocs_admin"
  sensitive   = true
}

variable "db_admin_secret_id" {
  description = "Riyadh Vault secret OCID containing the PostgreSQL bootstrap password."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true

  validation {
    condition     = var.db_admin_secret_id == null || can(regex("^ocid1\\.vaultsecret\\.oc1\\.me-riyadh-1\\.[A-Za-z0-9.]+$", var.db_admin_secret_id))
    error_message = "db_admin_secret_id must be a Riyadh Vault secret OCID."
  }
}

variable "db_admin_secret_version" {
  description = "Pinned numeric Vault secret version used to bootstrap PostgreSQL."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition     = var.db_admin_secret_version == null || (var.db_admin_secret_version >= 1 && floor(var.db_admin_secret_version) == var.db_admin_secret_version)
    error_message = "db_admin_secret_version must be a positive integer."
  }
}

variable "enable_database" {
  description = "Second-phase switch; enable only after the Vault password secret exists."
  type        = bool
  default     = false
}

variable "db_instance_count" {
  description = "Two nodes are the minimum reviewed production topology."
  type        = number
  default     = 2

  validation {
    condition     = var.db_instance_count >= 2
    error_message = "Production requires at least two PostgreSQL nodes."
  }
}
