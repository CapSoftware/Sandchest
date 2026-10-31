import os
import yaml
from flask import Flask, request

app = Flask(__name__)


@app.route("/ping", methods=["POST"])
def ping():
    host = request.form["host"]
    os.system("ping -c 1 " + host)
    return "ok"


def load(data):
    return yaml.load(data, Loader=yaml.SafeLoader)
