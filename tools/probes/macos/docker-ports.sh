for sock in "$HOME/.colima/default/docker.sock" "$HOME/.orbstack/run/docker.sock" /var/run/docker.sock; do
  if [ -S "$sock" ]; then
    DOCKER_HOST="unix://$sock" docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}|{{.Status}}' 2>/dev/null
    exit 0
  fi
done
exit 0
