variable "aws_region" {
  type        = string
  description = "Região para implantar recursos AWS"
  default     = "sa-east-1"
}
variable "environment" {
  type    = string
  default = "lab"
  validation {
    condition = contains(["lab", "staging", "production"], var.environment)
    error_message = "Escolha lab, staging ou production."
  }
}
variable "instance_type" {
  type        = string
  description = "Tipo da instância EC2 (pode gerar custos)."
  default     = "t3.small"
}
variable "vpc_cidr" {
  type    = string
  default = "10.72.0.0/16"
}
variable "subnet_cidr" {
  type    = string
  default = "10.72.1.0/24"
}
variable "ssh_key_name" {
  type        = string
  default     = null
  nullable    = true
  description = "Par de chaves SSH previamente criado, opcional; a porta 22 continua fechada. Prefira SSM."
}
