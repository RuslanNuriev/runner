Обновление ранера на сервере

1. Закомитить ранер
2. Зайти на сервер ssh -l v.timofeeva 10.79.64.196
3. Зайти в ранер на сервере cd ../runner/hub
4. Сделать sudo git pull
5. Сделать docker-compose stop
6. Сделать docker-compose up -d --scale chrome=10  (поднимает 10 контейнеров с хромом)

Поднять докер на сервере
sudo systemctl start docker