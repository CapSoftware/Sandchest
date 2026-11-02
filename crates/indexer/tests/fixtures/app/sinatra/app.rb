require 'sinatra'
require_relative 'helpers'

get '/hello/:name' do
  greet(params[:name])
end
