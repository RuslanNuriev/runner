FROM selenium/node-chrome:120.0-chromedriver-120.0-grid-4.17.0-20240123

RUN sudo apt-get update && sudo apt-get -y install libnss3-tools wget

RUN wget -P /tmp https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
    && wget -P /tmp https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
    && sudo mkdir -p /usr/local/share/ca-certificates/extra \
    && sudo cp /tmp/russian_trusted_root_ca_pem.crt /usr/local/share/ca-certificates/extra \
    && sudo cp /tmp/russian_trusted_sub_ca_pem.crt /usr/local/share/ca-certificates/extra \
    && sudo update-ca-certificates

RUN timeout 30 google-chrome --headless=new --dump-dom https://google.com || true

RUN certutil -A -n "Russian Trusted Root CA" -t "TCu,Cu,Tu" -i /tmp/russian_trusted_root_ca_pem.crt -d "sql:${HOME}/.pki/nssdb/"
RUN certutil -A -n "Russian Trusted Sub CA" -t "TCu,Cu,Tu" -i /tmp/russian_trusted_sub_ca_pem.crt -d "sql:${HOME}/.pki/nssdb/"
