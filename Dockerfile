FROM ubuntu:latest
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get -y update && apt-get install -y
RUN apt-get -y install build-essential
RUN apt-get -y install valgrind
