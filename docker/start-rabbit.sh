docker run -d \
--hostname place2-rabbit --name place2-rabbit \
-e RABBITMQ_DEFAULT_USER=opl -e "RABBITMQ_DEFAULT_PASS=password" \
-v ./rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf \
-p 5672:5672 -p 15672:15672 \
rabbitmq:3-management-alpine
