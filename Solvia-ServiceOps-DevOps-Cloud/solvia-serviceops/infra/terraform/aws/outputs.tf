output "instance_id" {
  value       = aws_instance.app.id
  description = "Identificador para acesso via AWS Systems Manager Session Manager"
}
output "public_ip" {
  value       = aws_instance.app.public_ip
  description = "Configure o registro DNS A do Solvia (IP pode mudar ao parar/iniciar)"
}
output "application_url_hint" {
  value = "https://SEU-DOMINIO (aponte DNS para ${aws_instance.app.public_ip})"
}
output "next_steps" {
  value = "Entre pelo EC2 > Connect > Session Manager, instale/copie app em /opt/solvia e configure .env.production em segredo. Consulte docs/DEVOPS-CLOUD.md."
}
